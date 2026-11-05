import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../lib/workflow-runtime";
import { replaceBaseUrlInDirectories, resolveStrmOutputPath } from "@media-track/workflow";

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    directoryPath?: string;
    directoryPaths?: string[];
    newBaseUrl?: string;
    useAllTasks?: boolean;
  } | null;

  if (!body || !body.newBaseUrl?.trim()) {
    return NextResponse.json(
      { error: "newBaseUrl 为必填项" },
      { status: 400 },
    );
  }

  const repo = getWorkflowRepository();
  let targetDirs: string[] = [];

  if (body.directoryPaths && Array.isArray(body.directoryPaths) && body.directoryPaths.length > 0) {
    targetDirs = body.directoryPaths.map((d) => d.trim()).filter(Boolean).map(resolveStrmOutputPath);
  } else if (body.directoryPath?.trim()) {
    targetDirs = [resolveStrmOutputPath(body.directoryPath.trim())];
  } else {
    // 自动汇聚当前账户下全部已配置 STRM 任务的本地输出路径
    const tasks = await repo.listStrmTasks(accountId);
    targetDirs = Array.from(new Set(tasks.map((t) => resolveStrmOutputPath(t.localOutputDir.trim())).filter(Boolean)));
  }

  if (targetDirs.length === 0) {
    return NextResponse.json(
      { error: "当前未检测到任何可用的 STRM 输出目录，请先创建 STRM 任务或指定目录路径" },
      { status: 400 },
    );
  }

  try {
    const result = await replaceBaseUrlInDirectories(
      targetDirs,
      body.newBaseUrl.trim(),
    );

    return NextResponse.json({
      ok: true,
      total: result.total,
      updated: result.updated,
      errors: result.errors,
      directories: result.directories,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
