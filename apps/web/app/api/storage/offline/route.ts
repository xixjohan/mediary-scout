import { NextResponse, type NextRequest } from "next/server";
import {
  createDriveFileManager,
  ingestCapabilityForBrand,
  isRegisteredStorageProvider,
} from "@media-track/workflow";
import { requirePermission } from "../../../../lib/auth-chain";
import { getScopedStorageCredentials } from "../../../../lib/media-scope";
import type { AccountStorageCredentials } from "../../../../features/storage-drives/contracts/storage-types";
import { isDemoMode } from "../../../../lib/demo-mode";
import {
  guardWriteTarget,
  libraryScopeErrorStatus,
} from "../../../../features/storage-drives/application/library-scope-guard";
import {
  executeIngestTasks,
  ingestCapabilitiesView,
  type IngestCapabilitiesView,
  type ShareTaskPayloadItem,
} from "../../../../features/storage-drives/application/brand-ingest-executors";

/**
 * 离线下载 / 分享转存的提交端点。
 *
 * 能力与分发都来自 `STORAGE_BRANDS.ingest`（见 brand-ingest-executors.ts）：
 * 本文件只负责 HTTP ——解析请求、鉴权、目录范围校验、把结果拼成响应。
 * 曾经的 5 条 `if (provider === …)` 品牌分支与手写能力表已经移除，那个缺陷是
 * 「注册表登记了 UC 盘，但这条链永远说不支持」。
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** GET 的响应体。保留 `OfflineCapabilities` 这个名字，前端既有 import 不变。 */
export type OfflineCapabilities = IngestCapabilitiesView;

export type { ShareTaskPayloadItem };

/**
 * 只为范围校验取一次目录列表。走 drive-service 的 fileManager 而不是品牌客户端，
 * 让面包屑解析与浏览页共用同一份实现（115 的 `path`、其它品牌的本地缓存）。
 */
async function listDirectoryForScope(
  creds: AccountStorageCredentials,
  directoryId: string,
): Promise<{ breadcrumbs: Array<{ id: string; name: string }> }> {
  const fileManager = createDriveFileManager({
    storageId: creds.id,
    provider: creds.provider,
    cookie: creds.cookie,
    credential: creds.credential,
    rootCid: creds.rootCid,
    moviesCid: creds.moviesCid,
    tvCid: creds.tvCid,
    animeCid: creds.animeCid,
  });
  return fileManager.listDirectory(directoryId);
}

function parseUrlsArray(body: Record<string, unknown>): string[] {
  if (Array.isArray(body["urls"])) {
    return body["urls"].filter((u): u is string => typeof u === "string").map((u) => u.trim()).filter(Boolean);
  }
  if (typeof body["url"] === "string") {
    const single = body["url"].trim();
    if (single) return [single];
  }
  return [];
}

function parseShareTasksArray(body: Record<string, unknown>): ShareTaskPayloadItem[] {
  if (!Array.isArray(body["shareTasks"])) return [];
  const list: ShareTaskPayloadItem[] = [];
  for (const item of body["shareTasks"]) {
    if (typeof item === "object" && item !== null) {
      const itemObj = item as Record<string, unknown>;
      const u = typeof itemObj["url"] === "string" ? itemObj["url"].trim() : "";
      if (u) {
        list.push({
          url: u,
          shareCode: typeof itemObj["shareCode"] === "string" ? itemObj["shareCode"].trim() : undefined,
          passcode: typeof itemObj["passcode"] === "string" ? itemObj["passcode"].trim() : undefined,
          brand: typeof itemObj["brand"] === "string" ? itemObj["brand"].trim() : undefined,
        });
      }
    }
  }
  return list;
}

export function parseOfflineRequestBody(value: unknown):
  | {
      ok: true;
      storageId?: string | undefined;
      urls: string[];
      shareTasks: ShareTaskPayloadItem[];
      directoryId?: string | undefined;
      torrentName?: string | undefined;
      torrentBase64?: string | undefined;
    }
  | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) {
    return { ok: false, error: "invalid body" };
  }
  const body = value as Record<string, unknown>;
  const storageId = typeof body["storageId"] === "string" ? body["storageId"].trim() : undefined;
  const directoryId = typeof body["directoryId"] === "string" ? body["directoryId"].trim() : undefined;
  const torrentName = typeof body["torrentName"] === "string" ? body["torrentName"].trim() : undefined;
  const torrentBase64 = typeof body["torrentBase64"] === "string" ? body["torrentBase64"].trim() : undefined;

  const urls = parseUrlsArray(body);
  const shareTasks = parseShareTasksArray(body);

  if (urls.length === 0 && shareTasks.length === 0 && !torrentBase64) {
    return { ok: false, error: "请提供至少一个有效的下载链接、分享链接或种子文件" };
  }

  return {
    ok: true,
    storageId,
    urls,
    shareTasks,
    directoryId,
    torrentName,
    torrentBase64,
  };
}

export async function GET(request: NextRequest) {
  const gate = await requirePermission(request, "storage:list");
  if (gate instanceof Response) return gate;

  const storageId = request.nextUrl.searchParams.get("storageId") || undefined;
  const creds = await getScopedStorageCredentials(storageId);
  if (!creds || !isRegisteredStorageProvider(creds.provider)) {
    return NextResponse.json({ error: "未找到连接的网盘账户" }, { status: 404, headers: NO_STORE });
  }

  // 能力只来自注册表；这里不再有第二份 provider 分支，也不发起任何网盘 API
  // 调用——能力查询不该依赖上游可达性（此前 GET 会顺带拉 115 离线任务列表，
  // 上游超时就拖慢整个弹窗，而那份 `tasks` 字段前端从未渲染）。
  return NextResponse.json(ingestCapabilitiesView(creds.provider), { headers: NO_STORE });
}

type ParsedOffline = Extract<ReturnType<typeof parseOfflineRequestBody>, { ok: true }>;

/** 解析请求体 + 定位网盘 + 种子上传能力门。返回 Response 表示应直接结束请求。 */
async function resolveSubmitContext(
  request: NextRequest,
): Promise<{ parsed: ParsedOffline; creds: AccountStorageCredentials } | NextResponse> {
  let parsed: ReturnType<typeof parseOfflineRequestBody>;
  try {
    parsed = parseOfflineRequestBody(await request.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400, headers: NO_STORE });
  }
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });

  const creds = await getScopedStorageCredentials(parsed.storageId);
  if (!creds || !isRegisteredStorageProvider(creds.provider)) {
    return NextResponse.json({ error: "未找到连接的网盘账户" }, { status: 404, headers: NO_STORE });
  }

  // 种子上传没有任何品牌实现消费路径（注册表 `supportsTorrentFile` 全为 false）。
  // 与其静默忽略，不如显式拒绝——「点了提交却提示『请提供链接』」是更难解释的失败。
  if (parsed.torrentBase64 && !ingestCapabilitiesView(creds.provider).supportsTorrentFile) {
    return NextResponse.json(
      { error: `【${ingestCapabilityForBrand(creds.provider).label}】暂不支持 BT 种子上传，请改用磁力链接或分享链接。` },
      { status: 400, headers: NO_STORE },
    );
  }
  return { parsed, creds };
}

export async function POST(request: NextRequest) {
  // 提交离线/转存 = storage:transfer（成员保留这项，见决策 2）；
  // 目标目录另有范围校验，防止"能发起"变成"能往任意目录写"。
  const gate = await requirePermission(request, "storage:transfer");
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403, headers: NO_STORE });
  const accountId = gate.accountId;

  const context = await resolveSubmitContext(request);
  if (context instanceof NextResponse) return context;
  const { parsed, creds } = context;
  const { storageId, urls, shareTasks, directoryId } = parsed;
  const targetDirId = directoryId || creds.moviesCid || creds.rootCid || "0";

  try {
    // 需求 2 的关键配套：决策 2 保留了成员的「发起获取」，所以转存目标必须落在
    // 媒体库范围内，否则"能发起"会变成"能往盘上任意目录写文件"。
    await guardWriteTarget({
      accountId,
      storageId,
      directoryId: targetDirId,
      permissions: gate.permissions,
      listDirectory: (dirId) => listDirectoryForScope(creds, dirId),
    });

    // 每一条都由注册表能力先行判定：不支持的协议/品牌在这一步就被拒，
    // 不会交给品牌分支碰运气。返回的 ok 只代表「平台已受理」。
    const allResults = await executeIngestTasks({
      creds,
      offlineUrls: urls,
      shareTasks,
      targetDirId,
    });

    // 全部条目都在预检阶段被拒（零 API 调用）= 请求本身不可执行 → 400，
    // 与原「该盘不支持离线」的对外契约一致；只要有一条真的提交了就回 200。
    if (allResults.length > 0 && allResults.every((r) => r.preflight === true)) {
      return NextResponse.json({ error: allResults[0]!.message ?? "没有可提交的任务" }, { status: 400, headers: NO_STORE });
    }

    return NextResponse.json(
      {
        ok: true,
        submitted: allResults.length,
        succeeded: allResults.filter((r) => r.ok).length,
        // 「已受理」不是「已落盘」。入库确认必须走 StorageExecutor.transfer。
        accepted: true,
        results: allResults,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error("[storage/offline] submit failed:", error);
    const message = error instanceof Error ? error.message : "提交下载或转存任务失败";
    // 范围校验的失败要给出可区分的状态码：越权 403 / 未配置 409，两者都不是 400。
    const status = libraryScopeErrorStatus(message) === 500 ? 400 : libraryScopeErrorStatus(message);
    return NextResponse.json({ error: message }, { status, headers: NO_STORE });
  }
}
