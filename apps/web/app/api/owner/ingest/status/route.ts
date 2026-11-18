import { connection, NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "../../../../../lib/owner-guard";
import { getWorkflowRepository } from "../../../../../composition/runtime-container";

/**
 * GET /api/owner/ingest/status?workflowRunIds=a,b,c
 *
 * 逐条投放的运行状态。数据源是 `workflow_runs` 记录本身（DB 是唯一事实源），
 * 不依赖任何进程内状态——刷新页面、多实例、crash 后重连都能看到真实进展。
 *
 * 只返回属于**请求者账号**的记录（`getWorkflowRunSnapshot` 自带 fail-closed
 * 作用域），因此站长也看不到别人的 run。
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_IDS = 20;

export async function GET(request: NextRequest) {
  await connection();

  const gate = await requireOwner(request);
  if (gate instanceof NextResponse) return gate;
  const accountId = gate.accountId;

  const raw = request.nextUrl.searchParams.get("workflowRunIds") ?? "";
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, MAX_IDS);
  if (ids.length === 0) return NextResponse.json({ submissions: [] }, { headers: NO_STORE });

  const repository = getWorkflowRepository();
  const submissions = [];
  for (const id of ids) {
    const record = await repository.getWorkflowRunSnapshot(id, accountId);
    if (record === null) continue;
    const run = record.workflowRun;
    submissions.push({
      workflowRunId: id,
      kind: run.kind,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      targetDirectoryId: readTargetDirectory(run.auditEvents),
      landedFileCount: readLandedFileCount(run.auditEvents),
      error: readFailureMessage(run.auditEvents),
    });
  }
  return NextResponse.json({ submissions }, { headers: NO_STORE });
}

function readTargetDirectory(events: Array<{ type: string; data?: Record<string, unknown> | undefined }>): string | null {
  for (const event of events) {
    if (event.type === "owner_ingest_queued") {
      const value = event.data?.["targetDirectoryId"];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return null;
}

function readLandedFileCount(events: Array<{ type: string; data?: Record<string, unknown> | undefined }>): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "owner_ingest_landed") {
      const count = event.data?.["fileCount"];
      return typeof count === "number" ? count : null;
    }
  }
  return null;
}

function readFailureMessage(events: Array<{ type: string; message?: string | undefined }>): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "owner_ingest_failed") return event.message ?? "投放失败";
  }
  return null;
}
