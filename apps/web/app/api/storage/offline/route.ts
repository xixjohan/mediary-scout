import { NextResponse, type NextRequest } from "next/server";
import {
  Pan115CookieClient,
  Pan123Client,
  GuangYaClient,
  QuarkCookieClient,
  TianyiClient,
  isRegisteredStorageProvider,
} from "@media-track/workflow";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getAccountStorageCredentials } from "../../../../features/storage-drives/application/drive-service";
import type { AccountStorageCredentials } from "../../../../features/storage-drives/contracts/storage-types";
import { isDemoMode } from "../../../../lib/demo-mode";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export interface OfflineCapabilities {
  supported: boolean;
  provider: string;
  schemes: string[];
  supportsTorrent: boolean;
  supportsOffline: boolean;
  supportsShareTransfer: boolean;
  supportedShareBrands: string[];
  message?: string | undefined;
  tasks?: unknown[] | undefined;
}

export interface ShareTaskPayloadItem {
  url: string;
  shareCode?: string | undefined;
  passcode?: string | undefined;
  brand?: string | undefined;
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

async function execute115Offline(
  client: Pan115CookieClient,
  urls: string[],
  targetDirId: string,
) {
  return Promise.all(
    urls.map(async (url) => {
      try {
        const res = await client.addOfflineTask({ url, directoryId: targetDirId });
        return { url, ok: res.ok, message: res.message || "已添加" };
      } catch (e) {
        return { url, ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    })
  );
}

async function execute123Offline(
  client: Pan123Client,
  urls: string[],
  targetDirId: string,
) {
  return Promise.all(
    urls.map(async (url) => {
      try {
        const resolved = await client.resolveOffline(url);
        const taskId = await client.submitOffline({
          resourceId: resolved.resourceId,
          fileIds: resolved.fileIds,
          uploadDirId: targetDirId,
        });
        return { url, ok: true, taskId };
      } catch (e) {
        return { url, ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    })
  );
}

async function executeGuangYaOffline(
  client: GuangYaClient,
  urls: string[],
  targetDirId: string,
) {
  return Promise.all(
    urls.map(async (url) => {
      try {
        const resolved = await client.resolveRes(url);
        const newName = resolved.btResInfo?.fileName || "offline-download";
        const taskId = await client.createTask({
          url,
          parentId: targetDirId,
          newName,
        });
        return { url, ok: true, taskId };
      } catch (e) {
        return { url, ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    })
  );
}

function createPan115Client(creds: AccountStorageCredentials): Pan115CookieClient {
  if (!creds.cookie) {
    throw new Error("115网盘凭证无效");
  }
  return new Pan115CookieClient({ cookie: creds.cookie });
}

function createPan123Client(creds: AccountStorageCredentials): Pan123Client {
  const token = typeof creds.credential?.["token"] === "string"
    ? (creds.credential["token"] as string)
    : (creds.cookie ?? "");
  if (!token) {
    throw new Error("123云盘凭证无效");
  }
  return new Pan123Client({ token });
}

function createGuangYaClient(creds: AccountStorageCredentials): GuangYaClient {
  const accessToken = typeof creds.credential?.["accessToken"] === "string"
    ? (creds.credential["accessToken"] as string)
    : "";
  const refreshToken = typeof creds.credential?.["refreshToken"] === "string"
    ? (creds.credential["refreshToken"] as string)
    : "";
  const deviceId = typeof creds.credential?.["deviceId"] === "string"
    ? (creds.credential["deviceId"] as string)
    : "";
  return new GuangYaClient({
    accessToken,
    refreshToken,
    ...(deviceId ? { deviceId } : {}),
  });
}

function createQuarkClient(creds: AccountStorageCredentials): QuarkCookieClient {
  if (!creds.cookie) {
    throw new Error("夸克网盘 Cookie 凭据无效");
  }
  return new QuarkCookieClient({ cookie: creds.cookie });
}

function createTianyiClient(creds: AccountStorageCredentials): TianyiClient {
  const c = (creds.credential ?? {}) as Record<string, string>;
  const sessionKey = c["sessionKey"] || "";
  const accessToken = c["accessToken"] || "";
  const refreshToken = c["refreshToken"] || "";
  const familySessionKey = c["familySessionKey"] || undefined;
  if (!sessionKey || !accessToken) {
    throw new Error("天翼云盘凭据无效");
  }
  return new TianyiClient({
    sessionKey,
    accessToken,
    refreshToken,
    ...(familySessionKey ? { familySessionKey } : {}),
  });
}

async function execute115ShareTransfer(
  client: Pan115CookieClient,
  tasks: ShareTaskPayloadItem[],
  targetDirId: string
) {
  const results = [];
  for (const t of tasks) {
    try {
      const shareCode = t.shareCode || "";
      const receiveCode = t.passcode || "";
      const res = await client.receiveShare({
        shareCode,
        receiveCode,
        directoryId: targetDirId,
      });
      results.push({
        url: t.url,
        ok: res.ok,
        message: res.ok ? "转存成功" : (res.message || "转存失败"),
      });
    } catch (e) {
      results.push({
        url: t.url,
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      });
    }
    // 串行限流防触发风控
    await new Promise((r) => setTimeout(r, 600));
  }
  return results;
}

async function executeQuarkShareTransfer(
  client: QuarkCookieClient,
  tasks: ShareTaskPayloadItem[],
  targetDirId: string
) {
  const results = [];
  for (const t of tasks) {
    try {
      const pwdId = t.shareCode || "";
      const passcode = t.passcode || "";
      const stoken = await client.getShareToken({ pwd_id: pwdId, passcode });
      const shareItems = await client.listShareDetail({ pwd_id: pwdId, stoken, pdirFid: "0" });
      const fidList = shareItems.map((i) => (i.fid ? String(i.fid) : "")).filter(Boolean);
      const fidTokenList = shareItems.map((i) => (i.share_fid_token ? String(i.share_fid_token) : "")).filter(Boolean);
      if (fidList.length === 0) {
        results.push({ url: t.url, ok: false, message: "分享链接中无可用文件" });
        continue;
      }
      const taskId = await client.saveShare({
        fid_list: fidList,
        fid_token_list: fidTokenList,
        to_pdir_fid: targetDirId,
        pwd_id: pwdId,
        stoken,
      });
      results.push({ url: t.url, ok: true, taskId, message: "夸克转存任务已提交" });
    } catch (e) {
      results.push({
        url: t.url,
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      });
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  return results;
}

async function execute123ShareTransfer(
  client: Pan123Client,
  tasks: ShareTaskPayloadItem[],
  targetDirId: string
) {
  const results = [];
  for (const t of tasks) {
    try {
      const shareKey = t.shareCode || "";
      const sharePwd = t.passcode || "";
      const res = await client.saveShare({
        shareKey,
        sharePwd,
        targetParentId: targetDirId,
      });
      results.push({ url: t.url, ok: res.ok, message: res.message || "转存成功" });
    } catch (e) {
      results.push({
        url: t.url,
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      });
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  return results;
}

async function executeTianyiShareTransfer(
  client: TianyiClient,
  tasks: ShareTaskPayloadItem[],
  targetDirId: string
) {
  const results = [];
  for (const t of tasks) {
    try {
      const shareCode = t.shareCode || "";
      const accessCode = t.passcode || "";
      const res = await client.saveShare({
        shareCode,
        accessCode,
        targetFolderId: targetDirId,
      });
      results.push({ url: t.url, ok: res.ok, message: res.message || "转存成功" });
    } catch (e) {
      results.push({
        url: t.url,
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      });
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  return results;
}

async function executeBrandOfflineTask(
  creds: AccountStorageCredentials,
  urls: string[],
  targetDirId: string
) {
  if (creds.provider === "pan115") {
    return execute115Offline(createPan115Client(creds), urls, targetDirId);
  }

  if (creds.provider === "pan123") {
    return execute123Offline(createPan123Client(creds), urls, targetDirId);
  }

  if (creds.provider === "guangya") {
    return executeGuangYaOffline(createGuangYaClient(creds), urls, targetDirId);
  }

  throw new Error(`网盘【${creds.provider}】暂不支持离线下载功能，请使用 115网盘 或 123云盘`);
}

async function executeBrandShareTransferTask(
  creds: AccountStorageCredentials,
  tasks: ShareTaskPayloadItem[],
  targetDirId: string
) {
  if (creds.provider === "pan115") {
    return execute115ShareTransfer(createPan115Client(creds), tasks, targetDirId);
  }

  if (creds.provider === "quark") {
    return executeQuarkShareTransfer(createQuarkClient(creds), tasks, targetDirId);
  }

  if (creds.provider === "pan123") {
    return execute123ShareTransfer(createPan123Client(creds), tasks, targetDirId);
  }

  if (creds.provider === "tianyi") {
    return executeTianyiShareTransfer(createTianyiClient(creds), tasks, targetDirId);
  }

  throw new Error(`网盘【${creds.provider}】暂不支持分享转存功能`);
}

export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  const storageId = request.nextUrl.searchParams.get("storageId") || undefined;
  const creds = await getAccountStorageCredentials(accountId, storageId);
  if (!creds || !isRegisteredStorageProvider(creds.provider)) {
    return NextResponse.json({ error: "未找到连接的网盘账户" }, { status: 404, headers: NO_STORE });
  }

  const { provider } = creds;

  if (provider === "pan115") {
    let tasks: unknown[] = [];
    try {
      if (creds.cookie) {
        const client = new Pan115CookieClient({ cookie: creds.cookie });
        tasks = await client.listOfflineTasks();
      }
    } catch (err) {
      console.warn("[storage/offline] 115 listOfflineTasks failed:", err);
    }
    const cap: OfflineCapabilities = {
      supported: true,
      provider,
      supportsOffline: true,
      supportsTorrent: true,
      supportsShareTransfer: true,
      supportedShareBrands: ["pan115"],
      schemes: ["magnet", "http", "https", "ftp", "ed2k"],
      tasks,
    };
    return NextResponse.json(cap, { headers: NO_STORE });
  }

  if (provider === "quark") {
    const cap: OfflineCapabilities = {
      supported: true,
      provider,
      supportsOffline: false,
      supportsTorrent: false,
      supportsShareTransfer: true,
      supportedShareBrands: ["quark"],
      schemes: [],
      tasks: [],
      message: "夸克网盘支持分享链接转存（秒级落盘）",
    };
    return NextResponse.json(cap, { headers: NO_STORE });
  }

  if (provider === "pan123") {
    const cap: OfflineCapabilities = {
      supported: true,
      provider,
      supportsOffline: true,
      supportsTorrent: true,
      supportsShareTransfer: true,
      supportedShareBrands: ["pan123"],
      schemes: ["magnet", "ed2k", "http", "https"],
      tasks: [],
    };
    return NextResponse.json(cap, { headers: NO_STORE });
  }

  if (provider === "tianyi") {
    const cap: OfflineCapabilities = {
      supported: true,
      provider,
      supportsOffline: false,
      supportsTorrent: false,
      supportsShareTransfer: true,
      supportedShareBrands: ["tianyi"],
      schemes: [],
      tasks: [],
      message: "天翼云盘支持分享链接转存",
    };
    return NextResponse.json(cap, { headers: NO_STORE });
  }

  if (provider === "guangya") {
    const cap: OfflineCapabilities = {
      supported: true,
      provider,
      supportsOffline: true,
      supportsTorrent: false,
      supportsShareTransfer: true,
      supportedShareBrands: ["guangya"],
      schemes: ["magnet", "ed2k"],
      tasks: [],
    };
    return NextResponse.json(cap, { headers: NO_STORE });
  }

  const cap: OfflineCapabilities = {
    supported: false,
    provider,
    supportsOffline: false,
    supportsTorrent: false,
    supportsShareTransfer: false,
    supportedShareBrands: [],
    schemes: [],
    tasks: [],
    message: `${provider} 暂不支持离线下载或转存功能`,
  };
  return NextResponse.json(cap, { headers: NO_STORE });
}

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403, headers: NO_STORE });
  const accountId = gate;

  let parsed: ReturnType<typeof parseOfflineRequestBody>;
  try {
    parsed = parseOfflineRequestBody(await request.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400, headers: NO_STORE });
  }
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  }

  const { storageId, urls, shareTasks, directoryId } = parsed;
  const creds = await getAccountStorageCredentials(accountId, storageId);
  if (!creds || !isRegisteredStorageProvider(creds.provider)) {
    return NextResponse.json({ error: "未找到连接的网盘账户" }, { status: 404, headers: NO_STORE });
  }

  const targetDirId = directoryId || creds.moviesCid || creds.rootCid || "0";

  try {
    const allResults: Array<{ url: string; ok: boolean; message?: string | undefined; taskId?: string | undefined }> = [];

    // 1. 若有离线下载链接
    if (urls.length > 0) {
      const offlineRes = await executeBrandOfflineTask(creds, urls, targetDirId);
      allResults.push(...offlineRes);
    }

    // 2. 若有网盘分享转存任务
    if (shareTasks.length > 0) {
      const shareRes = await executeBrandShareTransferTask(creds, shareTasks, targetDirId);
      allResults.push(...shareRes);
    }

    const successCount = allResults.filter((r) => r.ok).length;
    return NextResponse.json(
      {
        ok: true,
        submitted: allResults.length,
        succeeded: successCount,
        results: allResults,
      },
      { headers: NO_STORE }
    );
  } catch (error) {
    console.error("[storage/offline] submit failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "提交下载或转存任务失败" },
      { status: 400, headers: NO_STORE }
    );
  }
}
