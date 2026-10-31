import { NextResponse, type NextRequest } from "next/server";
import {
  Pan115CookieClient,
  Pan123Client,
  GuangYaClient,
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
  message?: string;
  tasks?: unknown[];
}

export function parseOfflineRequestBody(value: unknown): {
  ok: true;
  storageId?: string | undefined;
  urls: string[];
  directoryId?: string | undefined;
  torrentName?: string | undefined;
  torrentBase64?: string | undefined;
} | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) {
    return { ok: false, error: "invalid body" };
  }
  const body = value as Record<string, unknown>;
  const storageId = typeof body["storageId"] === "string" ? body["storageId"].trim() : undefined;
  const directoryId = typeof body["directoryId"] === "string" ? body["directoryId"].trim() : undefined;
  const torrentName = typeof body["torrentName"] === "string" ? body["torrentName"].trim() : undefined;
  const torrentBase64 = typeof body["torrentBase64"] === "string" ? body["torrentBase64"].trim() : undefined;

  let urls: string[] = [];
  if (Array.isArray(body["urls"])) {
    urls = body["urls"].filter((u): u is string => typeof u === "string").map((u) => u.trim()).filter(Boolean);
  } else if (typeof body["url"] === "string") {
    const single = body["url"].trim();
    if (single) urls = [single];
  }

  if (urls.length === 0 && !torrentBase64) {
    return { ok: false, error: "请提供至少一个有效的下载链接或种子文件" };
  }

  return {
    ok: true,
    storageId,
    urls,
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
    return NextResponse.json(
      {
        supported: true,
        provider,
        schemes: ["magnet", "http", "https", "ftp", "ed2k"],
        supportsTorrent: true,
        tasks,
      },
      { headers: NO_STORE }
    );
  }

  if (provider === "pan123") {
    return NextResponse.json(
      {
        supported: true,
        provider,
        schemes: ["magnet", "ed2k", "http", "https"],
        supportsTorrent: true,
        tasks: [],
      },
      { headers: NO_STORE }
    );
  }

  if (provider === "guangya") {
    return NextResponse.json(
      {
        supported: true,
        provider,
        schemes: ["magnet", "ed2k"],
        supportsTorrent: false,
        tasks: [],
      },
      { headers: NO_STORE }
    );
  }

  return NextResponse.json(
    {
      supported: false,
      provider,
      schemes: [],
      supportsTorrent: false,
      tasks: [],
      message: `${provider === "quark" ? "夸克网盘" : "天翼云盘"}暂未开放离线下载公开 API，推荐切换至 115网盘 或 123云盘`,
    },
    { headers: NO_STORE }
  );
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

  const { storageId, urls, directoryId } = parsed;
  const creds = await getAccountStorageCredentials(accountId, storageId);
  if (!creds || !isRegisteredStorageProvider(creds.provider)) {
    return NextResponse.json({ error: "未找到连接的网盘账户" }, { status: 404, headers: NO_STORE });
  }

  const targetDirId = directoryId || creds.moviesCid || creds.rootCid || "0";

  try {
    const results = await executeBrandOfflineTask(creds, urls, targetDirId);
    return NextResponse.json({ ok: true, submitted: results.length, results }, { headers: NO_STORE });
  } catch (error) {
    console.error("[storage/offline] submit failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "提交离线下载失败" },
      { status: 400, headers: NO_STORE }
    );
  }
}
