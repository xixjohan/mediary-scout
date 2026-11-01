import { NextResponse, type NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { isDemoMode } from "../../../../../lib/demo-mode";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../../lib/workflow-runtime";
import type { UpdateStrmTaskInput } from "@media-track/workflow";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  const { id } = await context.params;
  const repo = getWorkflowRepository();
  const task = await repo.getStrmTask(id, accountId);
  if (!task) {
    return NextResponse.json({ error: "STRM 任务不存在" }, { status: 404 });
  }

  return NextResponse.json(task);
}

function assignTextAndMode(
  target: UpdateStrmTaskInput,
  body: Partial<UpdateStrmTaskInput>,
): void {
  if (body.name?.trim()) target.name = body.name.trim();
  if (body.storageId?.trim()) target.storageId = body.storageId.trim();
  if (body.remoteFolderId?.trim()) target.remoteFolderId = body.remoteFolderId.trim();
  if (body.remotePath?.trim()) target.remotePath = body.remotePath.trim();
  if (body.localOutputDir?.trim()) target.localOutputDir = body.localOutputDir.trim();
  if (body.scanMode) target.scanMode = body.scanMode;
  if (body.deliveryMode) target.deliveryMode = body.deliveryMode;
  if (body.scheduleMode) target.scheduleMode = body.scheduleMode;
}

function assignFilterAndStatus(
  target: UpdateStrmTaskInput,
  body: Partial<UpdateStrmTaskInput>,
): void {
  if (body.scanIntervalMinutes !== undefined) target.scanIntervalMinutes = Number(body.scanIntervalMinutes);
  if (body.extensions !== undefined) target.extensions = body.extensions.trim();
  if (body.minFileSizeMb !== undefined) target.minFileSizeMb = Number(body.minFileSizeMb);
  if (body.excludeKeywords !== undefined) target.excludeKeywords = body.excludeKeywords?.trim() || null;
  if (typeof body.isActive === "boolean") target.isActive = body.isActive;
  if (body.status) target.status = body.status;
}

function buildUpdateInput(
  body: Partial<UpdateStrmTaskInput>,
  id: string,
  accountId: string,
): UpdateStrmTaskInput {
  const updateInput: UpdateStrmTaskInput = { id, accountId };
  assignTextAndMode(updateInput, body);
  assignFilterAndStatus(updateInput, body);
  return updateInput;
}

export async function PUT(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  }

  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as Partial<UpdateStrmTaskInput> | null;
  if (!body) {
    return NextResponse.json({ error: "无效的请求体" }, { status: 400 });
  }

  const repo = getWorkflowRepository();
  const existing = await repo.getStrmTask(id, accountId);
  if (!existing) {
    return NextResponse.json({ error: "STRM 任务不存在" }, { status: 404 });
  }

  // 状态机守卫：运行中任务不可修改扫描核心路径
  if (existing.status === "running") {
    return NextResponse.json(
      { error: "任务正在扫描执行中，无法修改配置，请等待扫描完成后再试" },
      { status: 409 },
    );
  }

  const updateInput = buildUpdateInput(body, id, accountId);
  const updated = await repo.updateStrmTask(updateInput);
  if (!updated) {
    return NextResponse.json({ error: "更新任务失败" }, { status: 500 });
  }

  return NextResponse.json(updated);
}

async function safelyCleanStrmFiles(dirPath: string): Promise<number> {
  let cleanedCount = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".strm")) {
        const fullPath = path.join(entry.parentPath || dirPath, entry.name);
        await fs.unlink(fullPath).catch(() => {});
        cleanedCount++;
      }
    }
  } catch {
    // 目录不存在或无权访问，忽略
  }
  return cleanedCount;
}

export async function DELETE(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  }

  const { id } = await context.params;
  const repo = getWorkflowRepository();
  const existing = await repo.getStrmTask(id, accountId);
  if (!existing) {
    return NextResponse.json({ error: "STRM 任务不存在" }, { status: 404 });
  }

  // 状态机守卫：运行中任务不可删除
  if (existing.status === "running") {
    return NextResponse.json(
      { error: "任务正在运行中，无法删除。请等待其执行完成。" },
      { status: 409 },
    );
  }

  const { searchParams } = new URL(request.url);
  const purgeFiles = searchParams.get("purgeFiles") === "true";
  let cleanedFilesCount = 0;

  if (purgeFiles && existing.localOutputDir) {
    cleanedFilesCount = await safelyCleanStrmFiles(existing.localOutputDir);
  }

  const success = await repo.deleteStrmTask(id, accountId);
  if (!success) {
    return NextResponse.json({ error: "删除任务失败" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    deletedId: id,
    purgedStrmFiles: cleanedFilesCount,
  });
}
