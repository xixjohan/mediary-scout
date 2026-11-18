import {
  GuangYaClient,
  Pan115CookieClient,
  Pan123Client,
  QuarkCookieClient,
  TianyiClient,
  UC_PROFILE,
  brandSupportsProwlarr,
  ingestCapabilityForBrand,
  isOfflineSchemeAllowed,
  parseGuangYaShareUrl,
} from "@media-track/workflow";
import type { AccountStorageCredentials } from "../contracts/storage-types";

/**
 * 按品牌执行离线下载 / 分享转存的唯一点。
 *
 * 为什么从路由里搬出来：这两个函数原来住在 `app/api/storage/offline/route.ts`，
 * 是 5 条 `if (provider === …)` 分支——与 `STORAGE_BRANDS.ingest` 声明平行存在且
 * 没有一致性断言。加 UC 盘时注册表登记了、分发链忘了，于是「注册表里有这家盘，
 * 但它的分享转存永远报不支持」。
 *
 * 现在分发链只有一条：能力**必须**来自 `ingestCapabilityForBrand(provider)`，
 * 该盘不支持的能力在提交前就被拒绝（零 API 调用），支持的能力走各自的品牌分支。
 * `storage-registry.test.ts` 的双向断言保证「声明了 → 一定有分支」。
 */

export interface IngestTaskResult {
  url: string;
  ok: boolean;
  message?: string | undefined;
  taskId?: string | undefined;
  /** 在提交前就被注册表能力拒掉（零 API 调用）。路由用它决定是否整体返回 400。 */
  preflight?: boolean | undefined;
}

export interface ShareTaskPayloadItem {
  url: string;
  shareCode?: string | undefined;
  passcode?: string | undefined;
  brand?: string | undefined;
}

/** 串行提交间隔。平台侧对连续转存/离线很敏感（115 风控、123 code=100011），
 *  单品牌的 client 自带漏桶只管「同一条连接」的节奏，跨任务仍需人为间隔。 */
const SUBMIT_INTERVAL_MS = 600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function credentialString(creds: AccountStorageCredentials, key: string): string {
  const value = creds.credential?.[key];
  return typeof value === "string" ? value : "";
}

function pan115Client(creds: AccountStorageCredentials): Pan115CookieClient {
  if (!creds.cookie) throw new Error("115网盘凭证无效");
  return new Pan115CookieClient({ cookie: creds.cookie });
}

function quarkClient(creds: AccountStorageCredentials): QuarkCookieClient {
  if (!creds.cookie) throw new Error("夸克网盘 Cookie 凭据无效");
  return new QuarkCookieClient({ cookie: creds.cookie });
}

function ucClient(creds: AccountStorageCredentials): QuarkCookieClient {
  if (!creds.cookie) throw new Error("UC网盘 Cookie 凭据无效");
  return new QuarkCookieClient({ cookie: creds.cookie, profile: UC_PROFILE });
}

function pan123Client(creds: AccountStorageCredentials): Pan123Client {
  const token = credentialString(creds, "token") || (creds.cookie ?? "");
  if (!token) throw new Error("123云盘凭证无效");
  return new Pan123Client({ token });
}

function guangyaClient(creds: AccountStorageCredentials): GuangYaClient {
  const accessToken = credentialString(creds, "accessToken");
  const refreshToken = credentialString(creds, "refreshToken");
  const deviceId = credentialString(creds, "deviceId");
  return new GuangYaClient({ accessToken, refreshToken, ...(deviceId ? { deviceId } : {}) });
}

function tianyiClient(creds: AccountStorageCredentials): TianyiClient {
  const sessionKey = credentialString(creds, "sessionKey");
  const accessToken = credentialString(creds, "accessToken");
  const refreshToken = credentialString(creds, "refreshToken");
  const familySessionKey = credentialString(creds, "familySessionKey");
  if (!sessionKey || !accessToken) throw new Error("天翼云盘凭据无效");
  return new TianyiClient({
    sessionKey,
    accessToken,
    refreshToken,
    ...(familySessionKey ? { familySessionKey } : {}),
  });
}

/** 品牌 → 客户端的单项构造表。新增品牌时这里多一项，漏一项会在
 *  `submitOffline` / `submitShare` 的默认分支抛错（而不是静默）——能力声明
 *  与实现一致性由 storage-registry.test.ts 双向断言。 */
const CLIENT_FACTORIES: Record<string, (creds: AccountStorageCredentials) => object> = {
  pan115: pan115Client,
  quark: quarkClient,
  uc: ucClient,
  pan123: pan123Client,
  guangya: guangyaClient,
  tianyi: tianyiClient,
};

export function createBrandClient(creds: AccountStorageCredentials): object {
  const factory = CLIENT_FACTORIES[creds.provider];
  if (!factory) throw new Error(`网盘【${creds.provider}】没有可用的品牌客户端`);
  return factory(creds);
}

// ── 离线提交（每品牌一个，submitOffline 只做分发）──────────────────────────

async function offlinePan115(creds: AccountStorageCredentials, url: string, targetDirId: string): Promise<IngestTaskResult> {
  const res = await pan115Client(creds).addOfflineTask({ url, directoryId: targetDirId });
  return { url, ok: res.ok, message: res.message || "已添加" };
}

async function offlinePan123(creds: AccountStorageCredentials, url: string, targetDirId: string): Promise<IngestTaskResult> {
  const client = pan123Client(creds);
  const resolved = await client.resolveOffline(url);
  const taskId = await client.submitOffline({
    resourceId: resolved.resourceId,
    fileIds: resolved.fileIds,
    uploadDirId: targetDirId,
  });
  return { url, ok: true, taskId };
}

async function offlineGuangya(creds: AccountStorageCredentials, url: string, targetDirId: string): Promise<IngestTaskResult> {
  const client = guangyaClient(creds);
  const resolved = await client.resolveRes(url);
  const newName = resolved.btResInfo?.fileName || "offline-download";
  const taskId = await client.createTask({ url, parentId: targetDirId, newName });
  return { url, ok: true, taskId };
}

const OFFLINE_HANDLERS: Record<string, (creds: AccountStorageCredentials, url: string, dir: string) => Promise<IngestTaskResult>> = {
  pan115: offlinePan115,
  pan123: offlinePan123,
  guangya: offlineGuangya,
};

/** 离线提交：按 brand 走各自的原生接口。提交成功只代表「平台受理」，
 *  不代表文件已经落到目标目录——落盘确认是 StorageExecutor.transfer 的职责。 */
async function submitOffline(creds: AccountStorageCredentials, url: string, targetDirId: string): Promise<IngestTaskResult> {
  const handler = OFFLINE_HANDLERS[creds.provider];
  const label = ingestCapabilityForBrand(creds.provider).label;
  if (!handler) return { url, ok: false, message: `网盘【${label}】没有离线下载通道` };
  try {
    return await handler(creds, url, targetDirId);
  } catch (error) {
    return { url, ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

// ── 分享转存（每品牌一个，submitShare 只做分发）──────────────────────────

async function sharePan115(creds: AccountStorageCredentials, task: ShareTaskPayloadItem, targetDirId: string): Promise<IngestTaskResult> {
  const res = await pan115Client(creds).receiveShare({
    shareCode: task.shareCode || "",
    receiveCode: task.passcode || "",
    directoryId: targetDirId,
  });
  return { url: task.url, ok: res.ok, message: res.ok ? "转存成功" : (res.message || "转存失败") };
}

async function shareCloudFamily(
  client: QuarkCookieClient,
  task: ShareTaskPayloadItem,
  targetDirId: string,
  label: string,
): Promise<IngestTaskResult> {
  const pwdId = task.shareCode || "";
  const passcode = task.passcode || "";
  const stoken = await client.getShareToken({ pwd_id: pwdId, passcode });
  const items = await client.listShareDetail({ pwd_id: pwdId, stoken, pdirFid: "0" });
  const fidList = items.map((item) => (item.fid ? String(item.fid) : "")).filter(Boolean);
  const fidTokenList = items.map((item) => (item.share_fid_token ? String(item.share_fid_token) : "")).filter(Boolean);
  if (fidList.length === 0) return { url: task.url, ok: false, message: `${label}分享链接中无可用文件` };
  const taskId = await client.saveShare({ fid_list: fidList, fid_token_list: fidTokenList, to_pdir_fid: targetDirId, pwd_id: pwdId, stoken });
  return { url: task.url, ok: true, taskId, message: "转存任务已提交" };
}

async function sharePan123(creds: AccountStorageCredentials, task: ShareTaskPayloadItem, targetDirId: string): Promise<IngestTaskResult> {
  const res = await pan123Client(creds).saveShare({
    shareKey: task.shareCode || "",
    sharePwd: task.passcode || "",
    targetParentId: targetDirId,
  });
  return { url: task.url, ok: res.ok, message: res.message || "转存成功" };
}

async function shareTianyi(creds: AccountStorageCredentials, task: ShareTaskPayloadItem, targetDirId: string): Promise<IngestTaskResult> {
  const res = await tianyiClient(creds).saveShare({
    shareCode: task.shareCode || "",
    accessCode: task.passcode || "",
    targetFolderId: targetDirId,
  });
  return { url: task.url, ok: res.ok, message: res.message || "转存成功" };
}

async function shareGuangya(creds: AccountStorageCredentials, task: ShareTaskPayloadItem, targetDirId: string): Promise<IngestTaskResult> {
  const client = guangyaClient(creds);
  // 光鸭分享转存是三步：换分享 accessToken → 列分享根目录 → restore_share。
  // 与 executor 内实现同一协议；这里只提交，落盘确认仍归 StorageExecutor。
  const parsed = parseGuangYaShareUrl(task.url);
  if (!parsed) throw new Error(`GUANGYA_SHARE_FAILED: unparseable share url: ${task.url.slice(0, 60)}`);
  const accessToken = await client.getShareAccessToken(parsed.shareId, task.passcode || parsed.code);
  const items = await client.listShareFiles(accessToken, "");
  const fileIds = items.map((item) => item.fileId).filter((id): id is string => Boolean(id));
  if (fileIds.length === 0) return { url: task.url, ok: false, message: "光鸭分享链接中无可用文件" };
  const taskId = await client.restoreShare({ accessToken, fileIds, parentId: targetDirId });
  return { url: task.url, ok: true, taskId, message: "转存任务已提交" };
}

const SHARE_HANDLERS: Record<string, (creds: AccountStorageCredentials, task: ShareTaskPayloadItem, dir: string) => Promise<IngestTaskResult>> = {
  pan115: sharePan115,
  quark: (creds, task, dir) => shareCloudFamily(quarkClient(creds), task, dir, "夸克网盘"),
  uc: (creds, task, dir) => shareCloudFamily(ucClient(creds), task, dir, "UC网盘"),
  pan123: sharePan123,
  tianyi: shareTianyi,
  guangya: shareGuangya,
};

/** 分享转存：各家 share 均按「同品牌才能接」的路由，与 ingest.supportedShareBrands 一致。 */
async function submitShare(creds: AccountStorageCredentials, task: ShareTaskPayloadItem, targetDirId: string): Promise<IngestTaskResult> {
  const handler = SHARE_HANDLERS[creds.provider];
  const label = ingestCapabilityForBrand(creds.provider).label;
  if (!handler) return { url: task.url, ok: false, message: `网盘【${label}】没有分享转存通道` };
  try {
    return await handler(creds, task, targetDirId);
  } catch (error) {
    return { url: task.url, ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

// ── 预检：能力声明先行判定（零 API 调用）───────────────────────────────

function preflightOffline(creds: AccountStorageCredentials, urls: readonly string[]): { accepted: string[]; rejected: IngestTaskResult[] } {
  const capability = ingestCapabilityForBrand(creds.provider);
  const accepted: string[] = [];
  const rejected: IngestTaskResult[] = [];
  for (const url of urls) {
    if (capability.supportsOffline && isOfflineSchemeAllowed(creds.provider, url)) {
      accepted.push(url);
      continue;
    }
    const scheme = url.slice(0, Math.max(0, url.indexOf(":"))).toUpperCase() || "未知";
    rejected.push({
      url,
      ok: false,
      preflight: true,
      message: capability.supportsOffline
        ? `【${capability.label}】不支持 ${scheme} 离线，可用协议：${capability.offlineSchemes.join(" / ").toUpperCase()}`
        : `【${capability.label}】暂不支持离线下载功能，请改用分享链接或切换网盘`,
    });
  }
  return { accepted, rejected };
}

function preflightShare(
  creds: AccountStorageCredentials,
  tasks: readonly ShareTaskPayloadItem[],
): { accepted: ShareTaskPayloadItem[]; rejected: IngestTaskResult[] } {
  const capability = ingestCapabilityForBrand(creds.provider);
  const accepted: ShareTaskPayloadItem[] = [];
  const rejected: IngestTaskResult[] = [];
  for (const task of tasks) {
    const brand = task.brand || "";
    if (capability.supportsShareTransfer && capability.supportedShareBrands.includes(brand)) {
      accepted.push(task);
      continue;
    }
    rejected.push({
      url: task.url,
      ok: false,
      preflight: true,
      message: `【${capability.label}】不能接收${brand || "该品牌"}的分享链接`,
    });
  }
  return { accepted, rejected };
}

/**
 * 一次提交的全部结果。**任何一条不满足「该盘声明的能力」都在这里被拒**，
 * 而不是交给品牌分支逐个碰运气——拒绝原因与 `ingest` 声明同源。
 */
export async function executeIngestTasks(input: {
  creds: AccountStorageCredentials;
  offlineUrls: readonly string[];
  shareTasks: readonly ShareTaskPayloadItem[];
  targetDirId: string;
}): Promise<IngestTaskResult[]> {
  const { creds, targetDirId } = input;
  const offline = preflightOffline(creds, input.offlineUrls);
  const share = preflightShare(creds, input.shareTasks);
  const results: IngestTaskResult[] = [...offline.rejected, ...share.rejected];

  for (const [index, url] of offline.accepted.entries()) {
    results.push(await submitOffline(creds, url, targetDirId));
    if (index < offline.accepted.length - 1) await sleep(SUBMIT_INTERVAL_MS);
  }
  for (const [index, task] of share.accepted.entries()) {
    results.push(await submitShare(creds, task, targetDirId));
    if (index < share.accepted.length - 1) await sleep(SUBMIT_INTERVAL_MS);
  }
  return results;
}

/** 能力查询的响应体：前端与 `/api/owner/ingest/*` 共用同一形状。 */
export interface IngestCapabilitiesView {
  supported: boolean;
  provider: string;
  schemes: string[];
  supportsTorrent: boolean;
  supportsTorrentFile: boolean;
  supportsOffline: boolean;
  supportsShareTransfer: boolean;
  supportedShareBrands: string[];
  message?: string;
}

export function ingestCapabilitiesView(provider: string): IngestCapabilitiesView {
  const capability = ingestCapabilityForBrand(provider);
  const supported = capability.supportsOffline || capability.supportsShareTransfer;
  const view: IngestCapabilitiesView = {
    supported,
    provider: capability.provider,
    schemes: [...capability.offlineSchemes],
    supportsTorrent: capability.supportsTorrent,
    supportsTorrentFile: capability.supportsTorrentFile,
    supportsOffline: capability.supportsOffline,
    supportsShareTransfer: capability.supportsShareTransfer,
    supportedShareBrands: [...capability.supportedShareBrands],
  };
  if (!supported) {
    view.message = `${capability.label} 暂不支持离线下载或转存功能`;
  } else if (!capability.supportsOffline) {
    view.message = `${capability.label}支持分享链接转存（秒级落盘）`;
  }
  return view;
}

/** 该盘是否挂了 Prowlarr —— 设置页用它决定「磁力来源」区块是否显示。 */
export function providerSupportsMagnetSources(provider: string): boolean {
  return brandSupportsProwlarr(provider);
}
