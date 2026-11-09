import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../lib/workflow-runtime";
import {
  normalizeBaseUrl,
  replaceBaseUrlInDirectories,
  resolveEffectiveStrmBaseUrl,
  resolveStrmOutputPath,
  STRM_BASE_URL_SETTING_KEY,
} from "@media-track/workflow";

export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  const repo = getWorkflowRepository();
  const configuredUrl = await repo.getSetting(STRM_BASE_URL_SETTING_KEY);
  const effectiveUrl = await resolveEffectiveStrmBaseUrl(repo);

  return NextResponse.json({
    ok: true,
    configuredUrl,
    effectiveUrl,
  });
}

interface ReplaceBaseUrlPayload {
  directoryPath?: string;
  directoryPaths?: string[];
  newBaseUrl?: string;
  useAllTasks?: boolean;
}

async function resolveTargetDirectories(
  body: ReplaceBaseUrlPayload,
  repo: ReturnType<typeof getWorkflowRepository>,
  accountId: string,
): Promise<string[]> {
  if (body.directoryPaths && Array.isArray(body.directoryPaths) && body.directoryPaths.length > 0) {
    return body.directoryPaths
      .map((d) => d.trim())
      .filter(Boolean)
      .map(resolveStrmOutputPath);
  }
  if (body.directoryPath?.trim()) {
    return [resolveStrmOutputPath(body.directoryPath.trim())];
  }
  const tasks = await repo.listStrmTasks(accountId);
  return Array.from(
    new Set(
      tasks
        .map((t) => resolveStrmOutputPath(t.localOutputDir.trim()))
        .filter(Boolean),
    ),
  );
}

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as ReplaceBaseUrlPayload | null;

  if (!body || !body.newBaseUrl?.trim()) {
    return NextResponse.json(
      { error: "newBaseUrl 为必填项" },
      { status: 400 },
    );
  }

  let normalizedBaseUrl: string;
  try {
    normalizedBaseUrl = normalizeBaseUrl(body.newBaseUrl.trim());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "无效的播放基址" },
      { status: 400 },
    );
  }

  const repo = getWorkflowRepository();
  const targetDirs = await resolveTargetDirectories(body, repo, accountId);

  if (targetDirs.length === 0) {
    return NextResponse.json(
      { error: "当前未检测到任何可用的 STRM 输出目录，请先创建 STRM 任务或指定目录路径" },
      { status: 400 },
    );
  }

  try {
    // 1. 批量重写磁盘上现有的 .strm 文件 URL 前缀
    const result = await replaceBaseUrlInDirectories(
      targetDirs,
      normalizedBaseUrl,
    );

    // 2. 【核心双写机制】将新基址永久持久化保存至数据库配置 (SSOT)，防止后续定时扫描和新增任务覆盖回 127.0.0.1
    await repo.setSetting(STRM_BASE_URL_SETTING_KEY, normalizedBaseUrl);

    return NextResponse.json({
      ok: true,
      total: result.total,
      updated: result.updated,
      errors: result.errors,
      directories: result.directories,
      persistedBaseUrl: normalizedBaseUrl,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
