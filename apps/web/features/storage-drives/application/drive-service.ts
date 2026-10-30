import {
  DEFAULT_ACCOUNT_ID,
  type StorageProvider,
  type TianyiQrSession,
  type TianyiSession,
  type TokenCredential,
} from "@media-track/contracts";
import {
  buildBootstrapExecutorForBrand,
  ConnectedStorage,
  createBootstrapPan115CookieStorageExecutor,
  createDriveFileManager,
  createExecutorForBrand,
  DriveFileManager,
  formatNetworkError,
  generateGuangYaDeviceId,
  getStorageBrand,
  GuangYaClient,
  isRegisteredStorageProvider,
  Pan115CookieClient,
  Pan123Client,
  parseCloudDriveUid,
  parsePan115Uid,
  parsePan123Uid,
  parseTianyiUid,
  provisionCategoryDirs,
  QuarkCookieClient,
  resolveQueueStorageChoice,
  resolveStorageBinding,
  TianyiClient,
  UC_PROFILE,
  WorkflowRepository,
} from "@media-track/workflow";
import {
  getWorkflowRepository,
  setPan115CookieHydrated,
} from "../../../composition/runtime-container";
import {
  AccountStorageCredentials,
  ConnectedStorageView,
  Pan115ConnectionStatus,
  StorageOwnedByOtherAccountError,
  TestConnectionResult,
} from "../contracts/storage-types";
import { customDirNamesFromEnv } from "../core/dir-naming";
import { extractStorageCredential } from "../core/credentials";

export const PAN115_COOKIE_KEY = "pan115.cookie";
export const PAN115_META_KEY = "pan115.cookieMeta";

export async function clearPan115GlobalMirrorForUnboundDrive(
  providerUid: string,
  repository: Pick<WorkflowRepository, "getSetting" | "deleteSetting"> = getWorkflowRepository(),
): Promise<void> {
  const cookie = (await repository.getSetting(PAN115_COOKIE_KEY))?.trim() ?? "";
  if (cookie) {
    const cookieUid = parsePan115Uid(cookie);
    if (cookieUid === null || cookieUid === providerUid) {
      await repository.deleteSetting(PAN115_COOKIE_KEY);
      await repository.deleteSetting(PAN115_META_KEY);
    }
  }
  const envCookie = (process.env.PAN115_COOKIE ?? "").trim();
  if (envCookie) {
    const envUid = parsePan115Uid(envCookie);
    if (envUid === null || envUid === providerUid) {
      delete process.env.PAN115_COOKIE;
    }
  }
  setPan115CookieHydrated(false);
}

export async function getPan115ConnectionStatus(): Promise<Pan115ConnectionStatus> {
  const repository = getWorkflowRepository();
  const cookie = await repository.getSetting(PAN115_COOKIE_KEY);
  if (cookie) {
    const metaRaw = await repository.getSetting(PAN115_META_KEY);
    let meta: { userName?: string; app?: string; connectedAt?: string } = {};
    try {
      meta = metaRaw ? (JSON.parse(metaRaw) as typeof meta) : {};
    } catch {
      meta = {};
    }
    return {
      connected: true,
      source: "qr",
      userName: meta.userName ?? null,
      app: meta.app ?? null,
      connectedAt: meta.connectedAt ?? null,
    };
  }
  if (process.env.PAN115_COOKIE) {
    return { connected: true, source: "env", userName: null, app: null, connectedAt: null };
  }
  return { connected: false, source: "none", userName: null, app: null, connectedAt: null };
}

export async function getAccountConnectedStorages(accountId: string): Promise<ConnectedStorageView[]> {
  const rows = await getWorkflowRepository().listConnectedStorages(accountId);
  return rows.map((row) => {
    const meta = (row.payload as { meta?: { connectedAt?: string } } | null)?.meta;
    return {
      id: row.id,
      provider: row.provider,
      providerUid: row.providerUid,
      label: row.label,
      connectedAt: meta?.connectedAt ?? null,
      createdAt: row.createdAt,
      status: row.status,
      provisioned: Boolean(row.tvCid && row.moviesCid && row.animeCid),
    };
  });
}

export async function refreshConnectedStorage(
  repository: WorkflowRepository,
  existing: { id: string; status: "active" | "frozen" },
  row: Parameters<WorkflowRepository["upsertConnectedStorage"]>[0],
): Promise<void> {
  await repository.upsertConnectedStorage(row);
  if (existing.status === "frozen") {
    await repository.setConnectedStorageStatus(existing.id, "active", null, null);
  }
}

export async function healMissingCidsOnRefresh(
  existing: ConnectedStorage,
  provider: string,
  cookie: string,
  credential: TokenCredential | null,
): Promise<{ rootCid: string | null; moviesCid: string | null; tvCid: string | null; animeCid: string | null }> {
  let { rootCid, moviesCid, tvCid, animeCid } = existing;
  if (process.env.MEDIA_TRACK_STORAGE_ADAPTER !== "fake" && !(rootCid && moviesCid && tvCid && animeCid)) {
    try {
      const p = await provisionDriveCategoryDirs(provider, cookie, credential);
      if (p.rootCid) {
        ({ rootCid, moviesCid, tvCid, animeCid } = p);
      }
    } catch (error) {
      console.error(`[media-track] ${provider} refresh directory heal failed: ${String(error)}`);
    }
  }
  return { rootCid, moviesCid, tvCid, animeCid };
}

export async function bindTokenConnectedStorage(input: {
  accountId: string;
  provider: string;
  providerUid: string;
  credentialBlob: Record<string, unknown>;
  meta: Record<string, unknown>;
  existing?: ConnectedStorage | null;
}): Promise<{ providerUid: string }> {
  const { accountId, provider, providerUid, credentialBlob, meta } = input;
  const repository = getWorkflowRepository();
  const existing =
    input.existing !== undefined
      ? input.existing
      : await repository.findConnectedStorageByUid(provider, providerUid);
  const decision = resolveStorageBinding({ provider, providerUid, accountId, existing });
  if (decision.action === "reject") {
    throw new StorageOwnedByOtherAccountError();
  }
  const payload = { ...credentialBlob, meta };
  if (decision.action === "refresh" && existing) {
    const cids = await healMissingCidsOnRefresh(existing, provider, "", credentialBlob);
    await refreshConnectedStorage(repository, existing, {
      id: existing.id,
      accountId,
      provider,
      providerUid,
      label: existing.label,
      payload,
      rootCid: cids.rootCid,
      moviesCid: cids.moviesCid,
      tvCid: cids.tvCid,
      animeCid: cids.animeCid,
      createdAt: existing.createdAt,
    });
    return { providerUid };
  }
  let cids: { rootCid: string | null; moviesCid: string | null; tvCid: string | null; animeCid: string | null } = {
    rootCid: null,
    moviesCid: null,
    tvCid: null,
    animeCid: null,
  };
  try {
    cids = await provisionDriveCategoryDirs(provider, "", credentialBlob);
  } catch (error) {
    console.error(`[media-track] ${provider} directory provision failed (will store without CIDs): ${String(error)}`);
  }
  const idSuffix = providerUid.replace(/[^A-Za-z0-9]/g, "").slice(0, 48);
  await repository.upsertConnectedStorage({
    id: `cs_${provider}_${idSuffix}`,
    accountId,
    provider,
    providerUid,
    label: null,
    payload,
    rootCid: cids.rootCid,
    moviesCid: cids.moviesCid,
    tvCid: cids.tvCid,
    animeCid: cids.animeCid,
    createdAt: new Date().toISOString(),
  });
  return { providerUid };
}

export async function provisionPan115CategoryDirs(
  cookie: string,
): Promise<{ rootCid: string | null; moviesCid: string | null; tvCid: string | null; animeCid: string | null }> {
  if (process.env.MEDIA_TRACK_STORAGE_ADAPTER === "fake") {
    return { rootCid: null, moviesCid: null, tvCid: null, animeCid: null };
  }
  try {
    const executor = createBootstrapPan115CookieStorageExecutor({ cookie });
    return await provisionCategoryDirs({
      baseParentId: "0",
      ...customDirNamesFromEnv(process.env),
      storage: {
        listChildDirs: (parentId: string) => executor.listChildDirectories(parentId),
        createDirectory: (dir) => executor.createDirectory(dir),
      },
    });
  } catch (error) {
    console.error(`[media-track] 115 directory provision failed: ${String(error)}`);
    return { rootCid: null, moviesCid: null, tvCid: null, animeCid: null };
  }
}

export async function refreshPan115Storage(
  repository: WorkflowRepository,
  existing: ConnectedStorage,
  input: { accountId: string; cookie: string; userName: string },
  payload: unknown,
): Promise<void> {
  let { rootCid, moviesCid, tvCid, animeCid } = existing;
  if (!(rootCid && moviesCid && tvCid && animeCid)) {
    const p = await provisionPan115CategoryDirs(input.cookie);
    if (p.rootCid) {
      ({ rootCid, moviesCid, tvCid, animeCid } = p);
    }
  }
  await refreshConnectedStorage(repository, existing, {
    id: existing.id,
    accountId: input.accountId,
    provider: "pan115",
    providerUid: existing.providerUid,
    label: input.userName,
    payload,
    rootCid,
    moviesCid,
    tvCid,
    animeCid,
    createdAt: existing.createdAt,
  });
}

export async function resolve115LandingCids(cookie: string): Promise<{
  rootCid: string | null;
  moviesCid: string | null;
  tvCid: string | null;
  animeCid: string | null;
}> {
  const envMovies = process.env.MEDIA_TRACK_MOVIES_PARENT_CID ?? null;
  const envTv = process.env.MEDIA_TRACK_TV_PARENT_CID ?? null;
  const envAnime = process.env.MEDIA_TRACK_ANIME_PARENT_CID ?? null;
  if (envMovies && envTv && envAnime) {
    return {
      rootCid: process.env.MEDIA_TRACK_115_TEST_ROOT_CID ?? null,
      moviesCid: envMovies,
      tvCid: envTv,
      animeCid: envAnime,
    };
  }
  const provisioned = await provisionPan115CategoryDirs(cookie);
  return {
    rootCid: provisioned.rootCid ?? process.env.MEDIA_TRACK_115_TEST_ROOT_CID ?? null,
    moviesCid: provisioned.moviesCid ?? envMovies,
    tvCid: provisioned.tvCid ?? envTv,
    animeCid: provisioned.animeCid ?? envAnime,
  };
}

export async function bindPan115ConnectedStorage(input: {
  accountId: string;
  cookie: string;
  userName: string;
  app: string;
}): Promise<void> {
  const repository = getWorkflowRepository();
  const providerUid = parsePan115Uid(input.cookie) ?? "pan115_default";
  const existing = await repository.findConnectedStorageByUid("pan115", providerUid);
  const decision = resolveStorageBinding({
    provider: "pan115",
    providerUid,
    accountId: input.accountId,
    existing,
  });
  if (decision.action === "reject") {
    throw new StorageOwnedByOtherAccountError();
  }
  const payload = {
    cookie: input.cookie,
    meta: { userName: input.userName, app: input.app, connectedAt: new Date().toISOString() },
  };
  if (decision.action === "refresh" && existing) {
    await refreshPan115Storage(repository, existing, input, payload);
    return;
  }
  const cids = await resolve115LandingCids(input.cookie);
  await repository.upsertConnectedStorage({
    id: `cs_${providerUid}`,
    accountId: input.accountId,
    provider: "pan115",
    providerUid,
    label: input.userName,
    payload,
    rootCid: cids.rootCid,
    moviesCid: cids.moviesCid,
    tvCid: cids.tvCid,
    animeCid: cids.animeCid,
    createdAt: new Date().toISOString(),
  });
}

export async function completePan115QrLogin(
  input: {
    session: { uid: string; time: number; sign: string; qrcodeContent: string };
    app?: string;
  },
  accountId: string,
): Promise<{ userName: string; app: string }> {
  const { Pan115QrLoginClient, PAN115_QR_LOGIN_APPS } = await import("@media-track/workflow");
  const app = (PAN115_QR_LOGIN_APPS as readonly string[]).includes(input.app ?? "")
    ? (input.app as (typeof PAN115_QR_LOGIN_APPS)[number])
    : "tv";
  const client = new Pan115QrLoginClient();
  const result = await client.exchangeCookie(input.session, app);
  await bindPan115ConnectedStorage({
    accountId,
    cookie: result.cookie,
    userName: result.userName,
    app: result.app,
  });
  const repository = getWorkflowRepository();
  if (accountId === DEFAULT_ACCOUNT_ID) {
    await repository.setSetting(PAN115_COOKIE_KEY, result.cookie);
    await repository.setSetting(
      PAN115_META_KEY,
      JSON.stringify({
        userName: result.userName,
        app: result.app,
        connectedAt: new Date().toISOString(),
      }),
    );
    process.env.PAN115_COOKIE = result.cookie;
    setPan115CookieHydrated(true);
  }
  return { userName: result.userName, app: result.app };
}

export async function connectPan115Cookie(
  rawCookie: string,
  accountId: string,
): Promise<{ providerUid: string; userName: string }> {
  const cookie = rawCookie.trim();
  if (!cookie) {
    throw new Error("Cookie 不能为空");
  }
  const providerUid = parsePan115Uid(cookie);
  if (!providerUid) {
    throw new Error("115 Cookie 格式不正确（未找到 UID，需包含 UID=...; CID=...; SEID=... 等）");
  }

  const userName = `115_${providerUid.slice(0, 8)}`;
  const app = "manual_cookie";

  await bindPan115ConnectedStorage({
    accountId,
    cookie,
    userName,
    app,
  });

  const repository = getWorkflowRepository();
  if (accountId === DEFAULT_ACCOUNT_ID) {
    await repository.setSetting(PAN115_COOKIE_KEY, cookie);
    await repository.setSetting(
      PAN115_META_KEY,
      JSON.stringify({
        userName,
        app,
        connectedAt: new Date().toISOString(),
      }),
    );
    process.env.PAN115_COOKIE = cookie;
    setPan115CookieHydrated(true);
  }
  return { providerUid, userName };
}

export async function connectCloudFamilyCookie(
  rawCookie: string,
  provider: "quark" | "uc",
  accountId: string,
): Promise<{ providerUid: string }> {
  const label = getStorageBrand(provider).label;
  const cookie = rawCookie.trim();
  if (!cookie) {
    throw new Error(`请粘贴${label} cookie。`);
  }
  const providerUid = parseCloudDriveUid(cookie);
  if (!providerUid) {
    throw new Error(
      `无法从该 cookie 解析${label}账号（需包含 __uid 或 __kps）；请从浏览器 Network 请求头复制完整 Cookie（Copy as cURL 最省事）。`,
    );
  }
  const repository = getWorkflowRepository();
  const existing = await repository.findConnectedStorageByUid(provider, providerUid);
  const decision = resolveStorageBinding({ provider, providerUid, accountId, existing });
  if (decision.action === "reject") {
    throw new StorageOwnedByOtherAccountError();
  }
  try {
    await probeStorageConnection(provider, cookie, "0", null);
  } catch (error) {
    throw new Error(
      `无法用该 cookie 连接${label}：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const payload = { cookie, meta: { connectedAt: new Date().toISOString() } };
  if (decision.action === "refresh" && existing) {
    const cids = await healMissingCidsOnRefresh(existing, provider, cookie, null);
    await refreshConnectedStorage(repository, existing, {
      id: existing.id,
      accountId,
      provider,
      providerUid,
      label: existing.label,
      payload,
      rootCid: cids.rootCid,
      moviesCid: cids.moviesCid,
      tvCid: cids.tvCid,
      animeCid: cids.animeCid,
      createdAt: existing.createdAt,
    });
    return { providerUid };
  }
  let cids: { rootCid: string | null; moviesCid: string | null; tvCid: string | null; animeCid: string | null } = {
    rootCid: null,
    moviesCid: null,
    tvCid: null,
    animeCid: null,
  };
  try {
    const executor = createExecutorForBrand({ provider, cookie, scopeCids: [] });
    cids = await provisionCategoryDirs({
      baseParentId: getStorageBrand(provider).provisionRootId,
      ...customDirNamesFromEnv(process.env),
      storage: {
        listChildDirs: (parentId: string) => executor.listChildDirectories(parentId),
        createDirectory: (dir) => executor.createDirectory(dir),
      },
    });
  } catch (error) {
    console.error(`[media-track] ${label} directory provision failed (will store without CIDs): ${String(error)}`);
  }
  const idSuffix = providerUid.replace(/[^A-Za-z0-9]/g, "").slice(0, 48);
  await repository.upsertConnectedStorage({
    id: `cs_${provider}_${idSuffix}`,
    accountId,
    provider,
    providerUid,
    label: null,
    payload,
    rootCid: cids.rootCid,
    moviesCid: cids.moviesCid,
    tvCid: cids.tvCid,
    animeCid: cids.animeCid,
    createdAt: new Date().toISOString(),
  });
  return { providerUid };
}

export async function connectQuarkCookie(rawCookie: string, accountId: string): Promise<{ providerUid: string }> {
  return connectCloudFamilyCookie(rawCookie, "quark", accountId);
}

export async function connectUcCookie(rawCookie: string, accountId: string): Promise<{ providerUid: string }> {
  return connectCloudFamilyCookie(rawCookie, "uc", accountId);
}

export async function completeCloudFamilyQrLogin(
  serviceTicket: string,
  provider: "quark" | "uc",
  accountId: string,
): Promise<{ providerUid: string }> {
  const { QuarkQrLoginClient, QUARK_QR_PROFILE, UC_QR_PROFILE } = await import("@media-track/workflow");
  const profile = provider === "uc" ? UC_QR_PROFILE : QUARK_QR_PROFILE;
  const { cookie } = await new QuarkQrLoginClient({ profile }).exchangeCookie(serviceTicket);
  return provider === "uc" ? connectUcCookie(cookie, accountId) : connectQuarkCookie(cookie, accountId);
}

export async function completeQuarkQrLogin(serviceTicket: string, accountId: string): Promise<{ providerUid: string }> {
  return completeCloudFamilyQrLogin(serviceTicket, "quark", accountId);
}

export async function completeUcQrLogin(serviceTicket: string, accountId: string): Promise<{ providerUid: string }> {
  return completeCloudFamilyQrLogin(serviceTicket, "uc", accountId);
}

export async function connectGuangYa(
  rawAccessToken: string,
  rawRefreshToken: string,
  accountId: string,
): Promise<{ providerUid: string }> {
  const accessToken = rawAccessToken.trim();
  const refreshToken = rawRefreshToken.trim();
  if (!accessToken || !refreshToken) {
    throw new Error("请填写光鸭 access_token 与 refresh_token。");
  }
  const deviceId = generateGuangYaDeviceId();
  const client = new GuangYaClient({ accessToken, refreshToken, deviceId });
  let providerUid: string;
  try {
    providerUid = await client.validateToken();
  } catch (error) {
    throw new Error(
      `无法用该 token 登录光鸭云盘（请确认 access_token / refresh_token 完整且未过期）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const existing = await getWorkflowRepository().findConnectedStorageByUid("guangya", providerUid);
  const pinnedDeviceId = (existing?.payload as { deviceId?: string } | null)?.deviceId ?? deviceId;
  return bindTokenConnectedStorage({
    accountId,
    provider: "guangya",
    providerUid,
    credentialBlob: { accessToken, refreshToken, deviceId: pinnedDeviceId },
    meta: { connectedAt: new Date().toISOString() },
    existing,
  });
}

export async function bindTianyiConnectedStorage(
  session: TianyiSession,
  accountId: string,
): Promise<{ providerUid: string }> {
  const providerUid = parseTianyiUid(session.loginName);
  if (!providerUid) {
    throw new Error("无法确定天翼云盘账号(登录返回的 loginName 为空);请重新扫码或粘贴 SSON 后重试。");
  }
  const credentialBlob: Record<string, unknown> = {
    sessionKey: session.sessionKey,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    ...(session.familySessionKey ? { familySessionKey: session.familySessionKey } : {}),
  };
  return bindTokenConnectedStorage({
    accountId,
    provider: "tianyi",
    providerUid,
    credentialBlob,
    meta: { connectedAt: new Date().toISOString(), loginName: session.loginName },
  });
}

export async function completeTianyiQrLogin(
  session: TianyiQrSession,
  redirectUrl: string,
  accountId: string,
): Promise<{ providerUid: string }> {
  const { TianyiQrLoginClient } = await import("@media-track/workflow");
  let tianyiSession: TianyiSession;
  try {
    tianyiSession = await new TianyiQrLoginClient().exchangeSession(session, redirectUrl);
  } catch (error) {
    throw new Error(`无法完成天翼扫码登录（请重新扫码）：${error instanceof Error ? error.message : String(error)}`);
  }
  return bindTianyiConnectedStorage(tianyiSession, accountId);
}

export async function connectTianyiSson(sson: string, accountId: string): Promise<{ providerUid: string }> {
  const trimmed = sson.trim();
  if (!trimmed) {
    throw new Error("请粘贴天翼 SSON cookie。");
  }
  const { TianyiQrLoginClient } = await import("@media-track/workflow");
  let session: TianyiSession;
  try {
    session = await new TianyiQrLoginClient().loginBySson(trimmed);
  } catch (error) {
    throw new Error(
      `无法用该 SSON 登录天翼云盘（请确认 cookie 完整且未过期）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return bindTianyiConnectedStorage(session, accountId);
}

export function parsePan123UidOrThrow(token: string): string {
  const providerUid = parsePan123Uid(token);
  if (!providerUid) {
    throw new Error("无法从该 token 识别 123网盘账号（不是有效的 123 登录 token）；请重新扫码或粘贴完整 token。");
  }
  return providerUid;
}

export async function bindPan123ConnectedStorage(rawToken: string, accountId: string): Promise<{ providerUid: string }> {
  const token = rawToken.trim();
  const providerUid = parsePan123UidOrThrow(token);
  return bindTokenConnectedStorage({
    accountId,
    provider: "pan123",
    providerUid,
    credentialBlob: { token },
    meta: { connectedAt: new Date().toISOString() },
  });
}

export async function completePan123QrLogin(token: string, accountId: string): Promise<{ providerUid: string }> {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new Error("扫码登录未返回 token，请重新扫码。");
  }
  parsePan123UidOrThrow(trimmed);
  try {
    await probeStorageConnection("pan123", "", null, { token: trimmed });
  } catch (error) {
    throw new Error(
      `无法用该扫码 token 连接 123网盘（请重新扫码）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return bindPan123ConnectedStorage(trimmed, accountId);
}

export async function connectPan123Token(rawToken: string, accountId: string): Promise<{ providerUid: string }> {
  const trimmed = rawToken.trim();
  if (!trimmed) {
    throw new Error("请粘贴 123网盘登录 token。");
  }
  parsePan123UidOrThrow(trimmed);
  try {
    await probeStorageConnection("pan123", "", null, { token: trimmed });
  } catch (error) {
    throw new Error(
      `无法用该 token 连接 123网盘（请确认 token 完整且未过期）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return bindPan123ConnectedStorage(trimmed, accountId);
}

export const STORAGE_PROBES: Record<
  StorageProvider,
  (input: {
    cookie: string;
    credential: TokenCredential | null;
    rootCid: string | null;
    onCredentialRefresh?: ((creds: unknown) => Promise<void>) | undefined;
  }) => Promise<void>
> = {
  pan115: async ({ cookie, rootCid }) => {
    await new Pan115CookieClient({ cookie, listPageDelayMs: 0 }).getDirectoryInfo({
      directoryId: rootCid ?? "0",
    });
  },
  quark: async ({ cookie, rootCid }) => {
    await new QuarkCookieClient({ cookie }).listItems({ directoryId: rootCid ?? "0" });
  },
  uc: async ({ cookie, rootCid }) => {
    await new QuarkCookieClient({ cookie, profile: UC_PROFILE }).listItems({ directoryId: rootCid ?? "0" });
  },
  guangya: async ({ credential, rootCid: _rootCid, onCredentialRefresh }) => {
    const blob = (credential ?? {}) as { accessToken?: string; refreshToken?: string; deviceId?: string };
    await new GuangYaClient({
      accessToken: blob.accessToken ?? "",
      refreshToken: blob.refreshToken ?? "",
      ...(blob.deviceId === undefined ? {} : { deviceId: blob.deviceId }),
      ...(onCredentialRefresh ? { onTokensRefreshed: onCredentialRefresh } : {}),
    }).validateToken();
  },
  tianyi: async ({ credential, rootCid: _rootCid, onCredentialRefresh }) => {
    const blob = (credential ?? {}) as {
      sessionKey?: string;
      accessToken?: string;
      refreshToken?: string;
      familySessionKey?: string;
    };
    await new TianyiClient({
      sessionKey: blob.sessionKey ?? "",
      accessToken: blob.accessToken ?? "",
      refreshToken: blob.refreshToken ?? "",
      ...(blob.familySessionKey === undefined ? {} : { familySessionKey: blob.familySessionKey }),
      ...(onCredentialRefresh ? { onCredentialRefresh } : {}),
    }).listFiles("-11");
  },
  pan123: async ({ credential, rootCid: _rootCid }) => {
    const blob = (credential ?? {}) as { token?: string };
    await new Pan123Client({ token: blob.token ?? "" }).listFiles("0", { maxPages: 1 });
  },
};

export async function probeStorageConnection(
  provider: string,
  cookie: string,
  rootCid: string | null,
  credential: TokenCredential | null,
  onCredentialRefresh?: ((creds: unknown) => Promise<void>) | undefined,
): Promise<void> {
  const probe = STORAGE_PROBES[provider as StorageProvider];
  if (!probe) {
    throw new Error(`unknown storage brand: ${provider}`);
  }
  return probe({ cookie, credential, rootCid, onCredentialRefresh });
}

export function frozenDriveMessage(provider: string | null, action: "获取" | "预定"): string {
  const label = provider ? getStorageBrand(provider).label : "网盘";
  return `该网盘已掉线，请重新扫码绑定同一个${label}后再${action}。`;
}

export async function freezeConnectedStorage(storageId: string, reason: string): Promise<void> {
  try {
    await getWorkflowRepository().setConnectedStorageStatus(
      storageId,
      "frozen",
      reason,
      new Date().toISOString(),
    );
    console.warn(`[media-track] froze connected_storage ${storageId}: ${reason}`);
  } catch (error) {
    console.error(`[media-track] failed to freeze ${storageId}: ${String(error)}`);
  }
}

export async function provisionDriveCategoryDirs(
  provider: string,
  cookie: string,
  credential: TokenCredential | null,
): Promise<{ rootCid: string; moviesCid: string; tvCid: string; animeCid: string }> {
  const brand = getStorageBrand(provider);
  const baseParentId = brand.provisionRootId;
  const executor =
    brand.authKind === "token"
      ? createExecutorForBrand({ provider, credential: credential ?? {}, scopeCids: [] })
      : brand.provider.startsWith("pan115")
        ? createBootstrapPan115CookieStorageExecutor({ cookie, env: process.env })
        : buildBootstrapExecutorForBrand(brand, { cookie, credential, env: process.env });
  return provisionCategoryDirs({
    baseParentId,
    ...customDirNamesFromEnv(process.env),
    storage: {
      listChildDirs: (parentId: string) => executor.listChildDirectories(parentId),
      createDirectory: (dir) => executor.createDirectory(dir),
    },
  });
}

export function makeTokenPersister(
  accountId: string,
  storageId: string,
  provider: string,
): (creds: unknown) => Promise<void> {
  return async (creds) => {
    try {
      const blob = (creds ?? {}) as Record<string, unknown>;
      const repository = getWorkflowRepository();
      const drive = (await repository.listConnectedStorages(accountId)).find((s) => s.id === storageId);
      if (!drive) {
        console.warn(
          `[media-track] ${provider} token refresh: drive ${storageId} (account ${accountId}) vanished, skip persist`,
        );
        return;
      }
      if (!extractStorageCredential(drive.provider, blob).credential) {
        console.warn(`[media-track] ${provider} token refresh: incomplete blob for ${storageId}, skip persist`);
        return;
      }
      const prevMeta = (drive.payload as { meta?: unknown } | null)?.meta;
      const payload = {
        ...blob,
        ...(prevMeta === undefined ? {} : { meta: prevMeta }),
      };
      await repository.upsertConnectedStorage({
        id: drive.id,
        accountId,
        provider: drive.provider,
        providerUid: drive.providerUid,
        label: drive.label,
        payload,
        rootCid: drive.rootCid,
        moviesCid: drive.moviesCid,
        tvCid: drive.tvCid,
        animeCid: drive.animeCid,
        createdAt: drive.createdAt,
      });
    } catch (error) {
      console.error(`[media-track] token refresh persist failed for ${storageId}: ${String(error)}`);
    }
  };
}

export async function healDriveProvisioning(
  repository: WorkflowRepository,
  accountId: string,
  creds: AccountStorageCredentials,
): Promise<boolean> {
  if (
    process.env.MEDIA_TRACK_STORAGE_ADAPTER === "fake" ||
    (creds.rootCid && creds.moviesCid && creds.tvCid && creds.animeCid)
  ) {
    return false;
  }
  try {
    const p = await provisionDriveCategoryDirs(creds.provider, creds.cookie, creds.credential);
    const drive = (await repository.listConnectedStorages(accountId)).find((s) => s.id === creds.id);
    if (!drive) return false;
    await repository.upsertConnectedStorage({
      id: drive.id,
      accountId,
      provider: drive.provider,
      providerUid: drive.providerUid,
      label: drive.label,
      payload: drive.payload,
      rootCid: p.rootCid,
      moviesCid: p.moviesCid,
      tvCid: p.tvCid,
      animeCid: p.animeCid,
      createdAt: drive.createdAt,
    });
    return true;
  } catch (error) {
    console.error(`[media-track] testConnection auto-provision failed for ${creds.id}: ${String(error)}`);
    return false;
  }
}

export async function testConnection(
  accountId: string,
  connectedStorageId: string,
): Promise<TestConnectionResult> {
  const repository = getWorkflowRepository();
  const existingStorage = (await repository.listConnectedStorages(accountId)).find(
    (s) => s.id === connectedStorageId,
  );
  const wasPendingProvision = Boolean(
    existingStorage &&
      !(existingStorage.rootCid && existingStorage.moviesCid && existingStorage.tvCid && existingStorage.animeCid),
  );

  const creds = await getAccountStorageCredentials(accountId, connectedStorageId);
  if (!creds) {
    return { ok: false, status: "frozen", message: "找不到该网盘的凭证。" };
  }
  const brand = getStorageBrand(creds.provider);
  try {
    await probeStorageConnection(
      creds.provider,
      creds.cookie,
      creds.rootCid,
      creds.credential,
      makeTokenPersister(accountId, creds.id, creds.provider),
    );
    await repository.setConnectedStorageStatus(creds.id, "active", null, null);
    const healed = await healDriveProvisioning(repository, accountId, creds);
    if (healed || wasPendingProvision) {
      return { ok: true, status: "active", message: "连接正常，目录已初始化就绪。" };
    }
    return { ok: true, status: "active", message: "连接正常。" };
  } catch (error) {
    if (brand.isAuthError(error)) {
      await freezeConnectedStorage(creds.id, error instanceof Error ? error.message : String(error));
      return { ok: false, status: "frozen", message: `网盘登录已失效，请重新绑定同一个${brand.label}。` };
    }
    return { ok: false, status: creds.status, message: `连接检测失败：${formatNetworkError(error)}` };
  }
}

export async function workerHasConfiguredDrive(): Promise<boolean> {
  if ((process.env.MEDIA_TRACK_STORAGE_ADAPTER ?? "fake") !== "115") {
    return true;
  }
  if ((process.env.PAN115_COOKIE ?? "").trim().length > 0) {
    return true;
  }
  try {
    return await getWorkflowRepository().hasAnyConnectedStorage();
  } catch {
    return false;
  }
}

export async function defaultDriveIdOf(accountId: string): Promise<string | null> {
  const storages = await getWorkflowRepository().listConnectedStorages(accountId);
  return storages.find((storage) => isRegisteredStorageProvider(storage.provider))?.id ?? null;
}

export async function getAccountStorageCredentials(
  accountId: string,
  connectedStorageId?: string | null,
): Promise<AccountStorageCredentials | null> {
  try {
    const storages = await getWorkflowRepository().listConnectedStorages(accountId);
    const drive = connectedStorageId
      ? storages.find(
          (storage) => storage.id === connectedStorageId && isRegisteredStorageProvider(storage.provider),
        )
      : storages.find((storage) => isRegisteredStorageProvider(storage.provider));
    if (!drive) {
      return null;
    }
    const { cookie, credential } = extractStorageCredential(drive.provider, drive.payload);
    if (!cookie && !credential) {
      return null;
    }
    let { rootCid, moviesCid, tvCid, animeCid } = drive;
    const liveMode = process.env.MEDIA_TRACK_STORAGE_ADAPTER !== "fake";
    if (liveMode && drive.status === "active" && !(rootCid && moviesCid && tvCid && animeCid)) {
      try {
        const p = await provisionDriveCategoryDirs(drive.provider, cookie, credential);
        ({ rootCid, moviesCid, tvCid, animeCid } = p);
        await getWorkflowRepository().upsertConnectedStorage({
          id: drive.id,
          accountId,
          provider: drive.provider,
          providerUid: drive.providerUid,
          label: drive.label,
          payload: drive.payload,
          rootCid,
          moviesCid,
          tvCid,
          animeCid,
          createdAt: drive.createdAt,
        });
        console.log(`[media-track] auto-provisioned ${drive.provider} dirs for ${drive.id} (root=${rootCid})`);
      } catch (error) {
        console.error(`[media-track] auto-provision failed for ${drive.id}: ${String(error)}`);
      }
    }
    return {
      id: drive.id,
      provider: drive.provider,
      status: drive.status,
      cookie,
      credential: credential as Record<string, unknown> | null,
      rootCid,
      moviesCid,
      tvCid,
      animeCid,
    };
  } catch (error) {
    console.error(`[media-track] failed to load storage credentials for ${accountId}: ${String(error)}`);
    return null;
  }
}

export async function getAccountDriveFileManager(
  accountId: string,
  connectedStorageId?: string | null,
): Promise<DriveFileManager | null> {
  const creds = await getAccountStorageCredentials(accountId, connectedStorageId);
  if (!creds) {
    return null;
  }
  return createDriveFileManager({
    storageId: creds.id,
    provider: creds.provider,
    cookie: creds.cookie,
    credential: creds.credential,
    rootCid: creds.rootCid,
    moviesCid: creds.moviesCid,
    tvCid: creds.tvCid,
    animeCid: creds.animeCid,
  });
}

export async function resolveQueueStorage(
  accountId: string,
  explicitConnectedStorageId?: string | null,
): Promise<{ id: string | null; frozen: boolean; unknown: boolean; provider: string | null }> {
  try {
    const storages = (await getWorkflowRepository().listConnectedStorages(accountId)).filter(
      (storage) => isRegisteredStorageProvider(storage.provider),
    );
    const choice = resolveQueueStorageChoice(storages, explicitConnectedStorageId);
    return { ...choice, provider: storages.find((storage) => storage.id === choice.id)?.provider ?? null };
  } catch {
    return { id: null, frozen: false, unknown: true, provider: null };
  }
}
