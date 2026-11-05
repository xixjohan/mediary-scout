import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../lib/workflow-runtime";
import { ensureStrmTaskConfigRegistry } from "../../../../composition/runtime-container";
import type { CreateStrmTaskInput } from "@media-track/workflow";
import { isValidStrmOutputPath } from "@media-track/workflow";
import { resolveStrmOutputPath } from "@media-track/workflow";
import fs from "node:fs/promises";

export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  const repo = getWorkflowRepository();
  const tasks = await repo.listStrmTasks(accountId);
  return NextResponse.json(tasks);
}

function applyOptionalTaskFields(task: CreateStrmTaskInput, body: Partial<CreateStrmTaskInput>): void {
  if (body.scanIntervalMinutes) task.scanIntervalMinutes = Number(body.scanIntervalMinutes);
  if (body.scanMode) task.scanMode = body.scanMode;
  if (body.extensions) task.extensions = body.extensions.trim();
  if (body.minFileSizeMb !== undefined) task.minFileSizeMb = Number(body.minFileSizeMb);
  if (body.excludeKeywords !== undefined) task.excludeKeywords = body.excludeKeywords;
  if (body.scheduleMode) task.scheduleMode = body.scheduleMode;
  if (body.deliveryMode) task.deliveryMode = body.deliveryMode;
  if (body.mediaServerId !== undefined) task.mediaServerId = body.mediaServerId || null;
  if (body.mediaLibraryId !== undefined) task.mediaLibraryId = body.mediaLibraryId || null;
  if (body.mediaLibraryName !== undefined) task.mediaLibraryName = body.mediaLibraryName || null;
}

function parseTaskInput(body: Partial<CreateStrmTaskInput>, accountId: string): CreateStrmTaskInput {
  const task: CreateStrmTaskInput = {
    accountId,
    name: body.name!.trim(),
    storageId: body.storageId!.trim(),
    remoteFolderId: body.remoteFolderId!.trim(),
    remotePath: body.remotePath?.trim() || "/",
    localOutputDir: body.localOutputDir!.trim(),
    isActive: true,
  };
  applyOptionalTaskFields(task, body);
  return task;
}

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as Partial<CreateStrmTaskInput> | null;
  if (!body) {
    return NextResponse.json({ error: "无效的请求体" }, { status: 400 });
  }

  if (!body.name || !body.storageId || !body.remoteFolderId || !body.localOutputDir) {
    return NextResponse.json(
      { error: "name, storageId, remoteFolderId, localOutputDir 必填" },
      { status: 400 },
    );
  }
  if (!isValidStrmOutputPath(body.localOutputDir)) {
    return NextResponse.json({ error: "STRM 输出目录必须是程序目录下 data/ 内的相对路径" }, { status: 400 });
  }
  try {
    await fs.mkdir(resolveStrmOutputPath(body.localOutputDir), { recursive: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? `STRM 输出目录不可用：${error.message}` : "STRM 输出目录不可用" }, { status: 400 });
  }

  const repo = getWorkflowRepository();
  const task = await repo.createStrmTask(parseTaskInput(body, accountId));
  ensureStrmTaskConfigRegistry().invalidate(task.id);
  return NextResponse.json(task, { status: 201 });
}
