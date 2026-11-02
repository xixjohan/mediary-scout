/**
 * Pure decision logic for Â§7 multi-account storage binding + category directory
 * provisioning. No I/O here â€?the repository (binding) and the real 115
 * storage adapter (dir provisioning) inject their effects. Keeping the rules pure
 * keeps the instance-wide uniqueness invariant and the idempotent find-or-create
 * testable without a database or a live ç½‘ç›˜.
 */
import { DEFAULT_ACCOUNT_ID } from "../domain/domain.js";

export interface ConnectedStorageRow {
  id: string;
  accountId: string;
  provider: string;
  providerUid: string;
}

/** A local account (identity). password_hash empty for the implicit default
 *  account in single-user mode (no login). */
export interface Account {
  id: string;
  username: string;
  passwordHash: string;
  groupId: string | null;
  isOwner: boolean;
  createdAt: string;
}

/** A login session row; the signed httpOnly cookie carries its id. */
export interface Session {
  id: string;
  accountId: string;
  expiresAt: string;
  createdAt: string;
}

/** A network drive bound to an account (full persisted shape). */
export interface ConnectedStorage {
  id: string;
  accountId: string;
  provider: string;
  providerUid: string;
  label: string | null;
  /** Opaque per-provider credentials, e.g. { cookie, cookieMeta, app, userName }. */
  payload: unknown;
  rootCid: string | null;
  moviesCid: string | null;
  tvCid: string | null;
  animeCid: string | null;
  /** active = usable; frozen = cookie died (e.g. logged in elsewhere) â†?no
   *  acquisition and no patrol run for this drive until re-bound to the same uid.
   *  Data is never lost while frozen. */
  status: "active" | "frozen";
  frozenReason: string | null;
  frozenAt: string | null;
  createdAt: string;
}

/** Upsert payload â€?nullable directory CIDs are optional at call sites. */
export interface UpsertConnectedStorageInput {
  id: string;
  accountId: string;
  provider: string;
  providerUid: string;
  label?: string | null;
  payload: unknown;
  rootCid?: string | null;
  moviesCid?: string | null;
  tvCid?: string | null;
  animeCid?: string | null;
  createdAt: string;
}

export type StorageBindingDecision =
  | { action: "insert" }
  | { action: "refresh"; storageId: string }
  | { action: "reject"; ownerAccountId: string };

/**
 * Enforce instance-wide UNIQUE(provider, provider_uid):
 * - unseen (provider, uid)        â†?insert a new connection
 * - already owned by this account â†?refresh (re-scan updates the cookie payload)
 * - owned by another account      â†?reject (never let two accounts bind one ç½‘ç›˜)
 */
export function resolveStorageBinding(input: {
  provider: string;
  providerUid: string;
  accountId: string;
  existing: ConnectedStorageRow | null;
}): StorageBindingDecision {
  const { existing, accountId } = input;
  if (!existing) {
    return { action: "insert" };
  }
  if (existing.accountId === accountId) {
    return { action: "refresh", storageId: existing.id };
  }
  return { action: "reject", ownerAccountId: existing.accountId };
}

export interface DirProvisionStorage {
  listChildDirs(parentId: string): Promise<Array<{ name: string; id: string }>>;
  createDirectory(input: { name: string; parentId: string }): Promise<string>;
}

export interface ProvisionedCids {
  rootCid: string;
  moviesCid: string;
  tvCid: string;
  animeCid: string;
}

/**
 * Idempotent: reuse a same-named directory if one already exists under the
 * parent, else create it. Safe to re-run on an already-provisioned ç½‘ç›˜ (the
 * second run finds every dir and creates nothing).
 *
 * Directory names are customisable (rootName / moviesName / tvName / animeName).
 * A blank or whitespace-only name falls back to its brand default â€?in
 * particular the root ALWAYS resolves to a real container folder, never to the
 * account root, so the drive's write scope can never widen to the whole account.
 */
export async function provisionCategoryDirs(input: {
  storage: DirProvisionStorage;
  baseParentId: string;
  rootName?: string | undefined;
  moviesName?: string | undefined;
  tvName?: string | undefined;
  animeName?: string | undefined;
}): Promise<ProvisionedCids> {
  const named = (value: string | undefined, fallback: string) => value?.trim() || fallback;
  const rootName = named(input.rootName, "Mediary Scout");
  const moviesName = named(input.moviesName, "Movies");
  const tvName = named(input.tvName, "TV");
  const animeName = named(input.animeName, "Anime");

  const baseChildren = await input.storage.listChildDirs(input.baseParentId);
  const existingRoot = baseChildren.find((dir) => dir.name === rootName);
  const rootCid = existingRoot
    ? existingRoot.id
    : await input.storage.createDirectory({ name: rootName, parentId: input.baseParentId });

  // If rootCid already existed, list it once to resolve all 3 categories without 3x waterfall calls;
  // if rootCid was freshly created, it is guaranteed empty so we skip listing it altogether.
  const rootChildren = existingRoot ? await input.storage.listChildDirs(rootCid) : [];
  const byName = new Map(rootChildren.map((dir) => [dir.name, dir.id]));
  const findOrCreateUnderRoot = async (name: string): Promise<string> => {
    const hit = byName.get(name);
    if (hit !== undefined) return hit;
    const created = await input.storage.createDirectory({ name, parentId: rootCid });
    byName.set(name, created);
    return created;
  };

  const moviesCid = await findOrCreateUnderRoot(moviesName);
  const tvCid = await findOrCreateUnderRoot(tvName);
  const animeCid = await findOrCreateUnderRoot(animeName);
  return { rootCid, moviesCid, tvCid, animeCid };
}

/** Extract the stable 115 user id from a cookie string (`UID=<digits>_...`). */
export function parsePan115Uid(cookie: string): string | null {
  const match = /(?:^|;|\s)UID=(\d+)/.exec(cookie);
  return match ? match[1]! : null;
}

/** Minimal repository surface the legacy-cookie migration needs (structural, so
 *  this file doesn't import WorkflowRepository and create a cycle). */
export interface LegacyCookieMigrationRepo {
  getSetting(key: string): Promise<string | null>;
  findConnectedStorageByUid(provider: string, providerUid: string): Promise<ConnectedStorage | null>;
  upsertConnectedStorage(row: UpsertConnectedStorageInput): Promise<void>;
}

const LEGACY_COOKIE_KEY = "pan115.cookie";
const LEGACY_COOKIE_META_KEY = "pan115.cookieMeta";

/**
 * Â§7 P0 migration (idempotent, startup): a pre-multi-account deployment stored
 * the single 115 cookie in the global `app_settings`. Move it into a
 * `connected_storages` row owned by the implicit default account, with directory
 * CIDs backfilled from the env the worker used to read. Re-running is a no-op
 * once the connection exists. Returns whether it created the connection.
 *
 * Single-user zero-change: the migrated cookie is byte-identical to the global
 * one, so the worker (which now resolves credentials per-account) sees the same
 * 115 session it always did.
 */
export async function migrateLegacyCookieToDefaultAccount(input: {
  repository: LegacyCookieMigrationRepo;
  env: NodeJS.ProcessEnv;
  now: string;
}): Promise<{ migrated: boolean; providerUid: string | null }> {
  const cookie = (await input.repository.getSetting(LEGACY_COOKIE_KEY))?.trim();
  if (!cookie) {
    return { migrated: false, providerUid: null };
  }
  // provider_uid keys the instance-wide UNIQUE(provider, provider_uid). Parse the
  // real 115 uid; fall back to a stable placeholder a later QR scan corrects.
  const providerUid = parsePan115Uid(cookie) ?? "pan115_default";
  const existing = await input.repository.findConnectedStorageByUid("pan115", providerUid);
  if (existing) {
    return { migrated: false, providerUid };
  }
  const metaRaw = await input.repository.getSetting(LEGACY_COOKIE_META_KEY);
  let meta: { userName?: string; app?: string; connectedAt?: string } = {};
  try {
    meta = metaRaw ? (JSON.parse(metaRaw) as typeof meta) : {};
  } catch {
    meta = {};
  }
  const env = input.env;
  await input.repository.upsertConnectedStorage({
    id: `cs_${providerUid}`,
    accountId: DEFAULT_ACCOUNT_ID,
    provider: "pan115",
    providerUid,
    label: meta.userName ?? null,
    payload: { cookie, meta },
    rootCid: env.MEDIA_TRACK_115_TEST_ROOT_CID ?? null,
    moviesCid: env.MEDIA_TRACK_MOVIES_PARENT_CID ?? null,
    tvCid: env.MEDIA_TRACK_TV_PARENT_CID ?? null,
    animeCid: env.MEDIA_TRACK_ANIME_PARENT_CID ?? null,
    createdAt: input.now,
  });
  return { migrated: true, providerUid };
}


/** 115 开放平台 OAuth 凭据定义（对接 115 Open API） */
export interface Pan115OpenOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // 毫秒时间戳
  clientId?: string;
  clientSecret?: string;
}

/** 115 网盘驱动执行引擎工作模式 */
export type Pan115EngineMode = "cookie_only" | "open_only" | "dual_engine";

/** 115 统一凭据载荷（存储在 connected_storages.payload） */
export interface Pan115UnifiedCredentialPayload {
  cookie?: string;
  cookieMeta?: Record<string, unknown>;
  openOAuth?: Pan115OpenOAuthCredentials;
  engineMode?: Pan115EngineMode;
}

/**
 * 判断 115 开放平台凭据是否有效可用
 */
export function isPan115OpenOAuthValid(creds?: Pan115OpenOAuthCredentials | null): boolean {
  if (!creds) return false;
  return (
    typeof creds.accessToken === "string" &&
    creds.accessToken.trim().length > 0 &&
    typeof creds.refreshToken === "string" &&
    creds.refreshToken.trim().length > 0
  );
}

/**
 * 智能决议 115 凭据的工作引擎模式：
 * - 兼具 Cookie 与有效 Open OAuth -> "dual_engine"（最佳推荐：转存走 Cookie，扫库与直链走 Open）
 * - 仅有 Open OAuth -> "open_only"（免掉线扫库与直链，不支持分享转存）
 * - 其余 -> "cookie_only"（传统 Web Cookie 模式）
 */
export function resolvePan115EngineMode(payload: unknown): Pan115EngineMode {
  if (!payload || typeof payload !== "object") {
    return "cookie_only";
  }
  const obj = payload as Record<string, unknown>;
  const hasCookie = typeof obj["cookie"] === "string" && (obj["cookie"] as string).trim().length > 0;
  const openOAuth = obj["openOAuth"] as Pan115OpenOAuthCredentials | undefined;
  const hasOAuth = isPan115OpenOAuthValid(openOAuth);

  // 若显式指定且凭据满足，尊重显式模式
  if (obj["engineMode"] === "dual_engine" && hasCookie && hasOAuth) {
    return "dual_engine";
  }
  if (obj["engineMode"] === "open_only" && hasOAuth) {
    return "open_only";
  }

  // 默认自动推断
  if (hasCookie && hasOAuth) {
    return "dual_engine";
  }
  if (hasOAuth && !hasCookie) {
    return "open_only";
  }
  return "cookie_only";
}
