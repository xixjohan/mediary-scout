import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../lib/workflow-runtime";
import type { CreateStrmTaskInput } from "@media-track/workflow";

export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  const repo = getWorkflowRepository();
  const tasks = await repo.listStrmTasks(accountId);
  return NextResponse.json(tasks);
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
  if (body.scanIntervalMinutes) task.scanIntervalMinutes = Number(body.scanIntervalMinutes);
  if (body.scanMode) task.scanMode = body.scanMode;
  if (body.extensions) task.extensions = body.extensions.trim();
  if (body.minFileSizeMb !== undefined) task.minFileSizeMb = Number(body.minFileSizeMb);
  if (body.excludeKeywords !== undefined) task.excludeKeywords = body.excludeKeywords;
  if (body.scheduleMode) task.scheduleMode = body.scheduleMode;
  if (body.deliveryMode) task.deliveryMode = body.deliveryMode;
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

  const repo = getWorkflowRepository();
  const task = await repo.createStrmTask(parseTaskInput(body, accountId));
  return NextResponse.json(task, { status: 201 });
}
