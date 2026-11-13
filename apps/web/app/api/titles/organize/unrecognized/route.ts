import { connection, NextResponse, type NextRequest } from "next/server";
import {
  buildRenamedFileName,
  extensionForContainer,
  scanUnrecognizedMedia,
  sniffVideoContainer,
  type StorageExecutor,
  type UnrecognizedMediaItem,
} from "@media-track/workflow";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { buildAccountContextResolver, getWorkflowRepository } from "../../../../../lib/workflow-runtime";
import { ensureStorageStreamResolver } from "../../../../../composition/runtime-container";

/**
 * /api/titles/organize/unrecognized — 缺扩展名正片的发现与修复。
 *
 * 115 转存偶尔会把文件名截断在发布组后缀上（`...AAC-ColorTV`），扩展名丢失后
 * 整理器认不出这些文件，它们就永远躺在 Season 目录里。这里提供两条能力：
 *
 * - `GET  ?storageId=&directoryId=` 列出疑似正片（只读，无副作用）；
 * - `POST { storageId, directoryId, fileIds? }` 读文件头确认容器格式后补后缀。
 *
 * 补后缀**不猜格式**：先 Range 取前 32 字节按 magic bytes 判定（ftyp / EBML /
 * RIFF+AVI / FLV / TS），判定不出来就跳过并在结果里说明，绝不瞎改成 mp4。
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;
const SNIFF_BYTES = 32;

interface RouteBody {
  storageId?: unknown;
  directoryId?: unknown;
  fileIds?: unknown;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 校验盘归属：越权返回 403，与 /api/titles/organize 保持一致语义。 */
async function resolveOwnedStorage(accountId: string, storageId: string) {
  const storages = await getWorkflowRepository().listConnectedStorages(accountId);
  return storages.some((item: { id: string }) => item.id === storageId);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  await connection();
  const accountId = await requireApiAccount(request);
  if (accountId instanceof Response) return accountId as NextResponse;

  const storageId = readString(request.nextUrl.searchParams.get("storageId"));
  const directoryId = readString(request.nextUrl.searchParams.get("directoryId"));
  if (!storageId || !directoryId) {
    return NextResponse.json(
      { error: "storageId 与 directoryId 均为必填。", code: "INVALID_QUERY" },
      { status: 400, headers: NO_STORE },
    );
  }
  if (!(await resolveOwnedStorage(accountId, storageId))) {
    return NextResponse.json({ error: "无权访问该网盘。", code: "STORAGE_FORBIDDEN" }, { status: 403, headers: NO_STORE });
  }

  const context = await buildAccountContextResolver()(accountId, storageId);
  if (!context?.storage) {
    return NextResponse.json({ error: "storage unavailable" }, { status: 409, headers: NO_STORE });
  }

  const items = await scanUnrecognizedMedia({ storage: context.storage, showDirectoryId: directoryId });
  return NextResponse.json({ count: items.length, items }, { status: 200, headers: NO_STORE });
}

/** Range 读取文件头并判定容器；失败返回 unknown（不阻断其它文件）。 */
async function sniffRemoteContainer(
  url: string,
  headers: Record<string, string> | undefined,
): Promise<"mp4" | "mkv" | "avi" | "flv" | "ts" | "unknown"> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { ...headers, Range: `bytes=0-${SNIFF_BYTES - 1}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return "unknown";
    const buffer = new Uint8Array(await res.arrayBuffer());
    return sniffVideoContainer(buffer);
  } catch {
    return "unknown";
  }
}

interface FixOutcome {
  fileId: string;
  from: string;
  to?: string;
  container?: string;
  reason?: string;
}

async function fixOne(input: {
  accountId: string;
  storageId: string;
  storage: StorageExecutor;
  item: UnrecognizedMediaItem;
}): Promise<FixOutcome> {
  const { item } = input;
  try {
    const resolved = await ensureStorageStreamResolver().resolveStream({
      storageId: input.storageId,
      fileId: item.fileId,
      fileName: item.fileName,
    });
    const container = await sniffRemoteContainer(resolved.url, resolved.headers);
    const extension = extensionForContainer(container);
    if (!extension) {
      return { fileId: item.fileId, from: item.fileName, reason: "无法识别容器格式（未改动）" };
    }
    const newName = buildRenamedFileName(item.fileName, extension);
    if (newName === item.fileName) {
      return { fileId: item.fileId, from: item.fileName, to: newName, container, reason: "已带扩展名" };
    }
    await input.storage.renameFile({
      directoryId: item.directoryId,
      fileId: item.fileId,
      newName,
    });
    return { fileId: item.fileId, from: item.fileName, to: newName, container };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { fileId: item.fileId, from: item.fileName, reason: `重命名失败：${message}` };
  }
}

/**
 * 回查改名是否真的生效。
 *
 * 实测发现：115 的 `files/batch_rename` 对**去掉扩展名**的改名返回 state=1，
 * 但文件实际没有变化。本路由只做"补扩展名"这一方向（115 接受），不过依赖
 * 上游"返回成功即成功"仍不可靠——所以改名后重新列举目录，名字不在列表里就按失败上报。
 * 回查本身失败（网络/权限）时不否定改名结论，避免误报。
 */
async function confirmRenames(input: {
  storage: StorageExecutor;
  results: FixOutcome[];
  targets: UnrecognizedMediaItem[];
}): Promise<FixOutcome[]> {
  const dirByFile = new Map(input.targets.map((item) => [item.fileId, item.directoryId]));
  const dirIds = new Set(
    input.results
      .filter((item) => item.to !== undefined && item.reason === undefined)
      .map((item) => dirByFile.get(item.fileId))
      .filter((dirId): dirId is string => typeof dirId === "string"),
  );

  const namesByDir = new Map<string, Set<string>>();
  for (const dirId of dirIds) {
    try {
      const tree = await input.storage.listTree({ directoryId: dirId });
      namesByDir.set(dirId, new Set(tree.filter((file) => !file.path.includes("/")).map((file) => file.path)));
    } catch {
      // 回查失败：保留原结论
    }
  }

  return input.results.map((item) => {
    if (item.to === undefined || item.reason !== undefined) return item;
    const dirId = dirByFile.get(item.fileId);
    const names = dirId ? namesByDir.get(dirId) : undefined;
    if (!names) return item;
    if (names.has(item.to)) return item;
    // 回查未见新名字：按失败上报（to 一并去掉，避免调用方误以为已改名）
    const failed: FixOutcome = {
      fileId: item.fileId,
      from: item.from,
      reason: "改名未生效（上游未接受）",
      ...(item.container ? { container: item.container } : {}),
    };
    return failed;
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  await connection();
  const accountId = await requireApiAccount(request);
  if (accountId instanceof Response) return accountId as NextResponse;

  let body: RouteBody;
  try {
    body = (await request.json()) as RouteBody;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400, headers: NO_STORE });
  }

  const storageId = readString(body.storageId);
  const directoryId = readString(body.directoryId);
  if (!storageId || !directoryId) {
    return NextResponse.json(
      { error: "storageId 与 directoryId 均为必填。", code: "INVALID_BODY" },
      { status: 400, headers: NO_STORE },
    );
  }
  if (!(await resolveOwnedStorage(accountId, storageId))) {
    return NextResponse.json({ error: "无权访问该网盘。", code: "STORAGE_FORBIDDEN" }, { status: 403, headers: NO_STORE });
  }

  const context = await buildAccountContextResolver()(accountId, storageId);
  if (!context?.storage) {
    return NextResponse.json({ error: "storage unavailable" }, { status: 409, headers: NO_STORE });
  }

  // 只处理服务端自己扫出来的条目：客户端传的 fileId 仅用于筛选，不采信其文件名。
  const candidates = await scanUnrecognizedMedia({ storage: context.storage, showDirectoryId: directoryId });
  const requested = Array.isArray(body.fileIds)
    ? new Set(body.fileIds.filter((id): id is string => typeof id === "string"))
    : null;
  const targets = requested ? candidates.filter((item) => requested.has(item.fileId)) : candidates;

  const outcomes: FixOutcome[] = [];
  for (const item of targets) {
    outcomes.push(await fixOne({ accountId, storageId, storage: context.storage, item }));
  }

  const results = await confirmRenames({ storage: context.storage, results: outcomes, targets });
  const fixed = results.filter((item) => item.to !== undefined && item.reason === undefined);
  return NextResponse.json(
    { scanned: candidates.length, fixed: fixed.length, results },
    { status: 200, headers: NO_STORE },
  );
}
