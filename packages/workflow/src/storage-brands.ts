/**
 * Storage brand registry — the per-(account, drive) capabilities the worker and
 * web share, keyed by `connected_storages.provider`. Replaces the old global
 * `MEDIA_TRACK_STORAGE_ADAPTER==="115"` switch: dispatch is now per-drive, so one
 * account can hold a 115 drive and a quark drive side by side (tree model).
 *
 * The registry is SELF-CONTAINED: each brand carries its own `create`, so adding
 * a drive is adding one entry. Before the merge, executor construction lived in
 * a separate `storage-executor-factory.ts` as five `if` branches, and nothing at
 * compile time forced the two to stay in sync — registering a brand and forgetting
 * its factory branch only blew up at runtime. `create` is a required field, so
 * that class of drift is now a compile error (see storage-registry.test.ts for
 * the runtime guard that also covers callers who bypass the type).
 */
import { parsePan115Uid } from "./account-credentials.js";
import { withBrandPacing } from "./brand-pacing.js";
import type { ResourceType } from "./domain.js";
import { GuangYaClient } from "./guangya-client.js";
import type { GuangYaClientOptions } from "./guangya-client.js";
import { GuangYaStorageExecutor } from "./guangya-storage-executor.js";
import { isGuangYaAuthError, parseGuangYaUid } from "./guangya-client.js";
import {
  DEAD_LINKS_BLACK_BOX,
  DEAD_LINKS_BLACK_BOX_GUANGYA,
  DEAD_LINKS_BLACK_BOX_PAN123,
  DEAD_LINKS_BLACK_BOX_QUARK,
  DEAD_LINKS_BLACK_BOX_TIANYI,
} from "./acquisition-v2/skill-manuals.js";
import {
  TRANSFER_MODEL_NOTE_GUANGYA,
  TRANSFER_MODEL_NOTE_PAN123,
  TRANSFER_MODEL_NOTE_QUARK,
  TRANSFER_MODEL_NOTE_TIANYI,
} from "./acquisition-v2/transfer-model-notes.js";
import { isPan115AuthError } from "./pan115-cookie-client.js";
import {
  createBootstrapPan115CookieStorageExecutor,
  createProtectedPan115CookieStorageExecutorFromEnv,
} from "./pan115-storage-factory.js";
import { isPan123AuthError, parsePan123Uid } from "./pan123-client.js";
import type { Pan123Credential } from "./pan123-client.js";
import { Pan123Client } from "./pan123-client.js";
import { Pan123StorageExecutor } from "./pan123-storage-executor.js";
import { isQuarkAuthError, parseQuarkUid } from "./quark-cookie-client.js";
import { QuarkCookieClient } from "./quark-cookie-client.js";
import { QuarkStorageExecutor } from "./quark-storage-executor.js";
import type { StorageExecutor } from "./ports.js";
import { isTianyiAuthError, parseTianyiUid } from "./tianyi-client.js";
import type { TianyiClientOptions, TianyiCredential } from "./tianyi-client.js";
import { TianyiClient } from "./tianyi-client.js";
import { TianyiStorageExecutor } from "./tianyi-storage-executor.js";

export type StorageProvider = "pan115" | "quark" | "guangya" | "tianyi" | "pan123";
export type ResourceProviderKind =
  | "pansou-115"
  | "pansou-quark"
  | "pansou-magnet"
  | "pansou-tianyi"
  | "pansou-123"
  | "pansou-guangya"
  | "prowlarr";

/** Input to a brand's `create`. Mirrors what the old factory took, so callers
 *  (workflow-runtime's per-drive dispatch) are unchanged by the merge. */
export interface StorageDriverCreateInput {
  provider: string;
  /** Cookie credential for cookie-auth brands (115/夸克). Optional now that 光鸭
   *  authenticates with a token blob instead — pass `credential` for those. */
  cookie?: string;
  /** Opaque credential blob for token-auth brands (光鸭: {accessToken,refreshToken,deviceId};
   *  天翼: {sessionKey,accessToken,refreshToken,familySessionKey?}; 123: {token}). */
  credential?: unknown;
  /** The drive's write-scope directory ids (rootCid + Movies/TV/Anime). */
  scopeCids: string[];
  /** Base env for the 115 executor (guard pacing etc); defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Persist hook for refreshed token-auth credentials (光鸭 refresh rotates tokens;
   *  天翼 session 自愈轮换 sessionKey/accessToken). */
  onCredentialRefresh?: (creds: unknown) => void | Promise<void>;
}

export interface StorageBrand {
  provider: StorageProvider;
  /** Display name shown in the UI (switcher chip, settings tab). */
  label: string;
  /** Extract the instance-wide-unique account id from the brand's credential —
   *  a cookie string for cookie brands (115/夸克), a JWT access token for 光鸭,
   *  the loginName for 天翼. Callers pass the brand-appropriate string, never a
   *  JSON blob (a blob would rotate with tokens and destabilize
   *  UNIQUE(provider, provider_uid)). */
  parseUid: (credential: string) => string | null;
  /** Whether an error is this brand's dead-credential signal (drives freeze on it). */
  isAuthError: (err: unknown) => boolean;
  /** Resource providers applicable to this brand. Share-link brands (夸克/天翼)
   *  have no magnet web API, so they omit "prowlarr" — magnet is 115/光鸭/123 only. */
  resourceProviderKinds: ResourceProviderKind[];
  /** Whether to strengthen the Chinese-subs soft default for this brand. When true,
   *  the agent prompt emphasizes that Chinese-titled resources from this drive are
   *  more likely to carry Chinese subs (these are Chinese-world drives where resources
   *  mostly come from the Chinese community). Set to false for magnet-only drives. */
  assumeChineseSubsFromChineseTitle: boolean;
  /** Credential shape: "cookie" brands (115/夸克) store a raw cookie string;
   *  "token" brands (光鸭/天翼) store a JSON token blob. workflow-runtime routes
   *  credential extraction, executor dispatch, and refresh persistence on this
   *  field — replacing the old hardcoded `provider === "guangya"` checks. */
  authKind: "cookie" | "token";
  /** Parent directory id under which connect-time provisioning creates the
   *  Mediary Scout/{Movies,TV,Anime} tree — per-brand DATA, not logic. 115 & 夸克
   *  both root at "0"; 光鸭 roots at "" (account root); 天翼 personal-cloud roots
   *  at "-11". Consumed as `provisionCategoryDirs`' baseParentId so the root is
   *  registry-driven instead of hardcoded at each provision call site. */
  provisionRootId: string;
  /** For "token" brands only: the credential-blob keys that MUST each be a
   *  non-empty string for the drive to count as connected — 光鸭 needs
   *  accessToken+refreshToken (deviceId optional, rides in the blob); 天翼 needs
   *  the sessionKey+accessToken+refreshToken trio. `extractStorageCredential`
   *  reads this instead of a per-brand `if`, returning the raw blob when every
   *  key is present (the client trims/validates the rest downstream). Undefined
   *  for cookie brands (115/夸克), which authenticate with a cookie string. */
  requiredCredentialKeys?: string[];
  /** How the brand's executor decides a write is inside the drive's scope.
   *  "parents": it looks the target's parents up on the drive until it reaches a scope
   *  root (115 / 夸克). "listed": it only writes into a scope root, a dir it created, or
   *  a dir it listed under an in-scope parent in this run (光鸭 / 天翼 / 123) — a dir id
   *  handed over from another run must be reached again from a scope root first. */
  writeScope: "parents" | "listed";
  /** Build this brand's executor. REQUIRED — this is what makes the registry
   *  self-contained: a brand registered without its executor wired is a compile
   *  error, not a runtime surprise discovered the first time that drive tries
   *  to transfer. `buildExecutorForBrand` still throws at runtime for callers
   *  that bypass the type (JS callers, `as` casts). */
  create: (input: StorageDriverCreateInput) => StorageExecutor;
  /** Minimum start-to-start gap between this drive's API calls, in ms.
   *  REGISTRY DATA, not logic — this used to be a `provider === "pan123"` check
   *  buried in drive-pacer.ts. 123 answers a burst with code=100011 请勿频繁操作,
   *  so its calls are spaced; the others pace themselves INSIDE their own client
   *  (115's 1.2s leaky bucket, 夸克's 3/s token bucket) and must not be spaced a
   *  second time out here.
   *
   *  REQUIRED, defaulting to nothing: `withBrandPacing` wraps an unregistered
   *  brand with zero pacing, so a new drive ships unlimited — that is the
   *  account-ban entry point (plan §2.3). Making the field mandatory forces
   *  whoever adds a brand to answer "does this drive need spacing?". */
  minApiIntervalMs: number;
  /** The brand's transfer / dead-links / black-box manual, handed to the agent for
   *  a run on this drive. The transfer model differs by brand (115 秒传/magnet vs
   *  夸克 转存分享链/无磁力), so a wrong manual has the agent operate the drive
   *  with the wrong steps.
   *
   *  REQUIRED: it used to be five `if (provider === ...)` branches in
   *  acquisition-v2/skill.ts, where forgetting one silently handed the agent
   *  ANOTHER brand's manual. The text itself stays in skill.ts (it is agent-facing
   *  documentation); only the "which manual is mine" pointer lives here. */
  deadLinksSkill: string;
  /** Build an executor for PROVISIONING a drive's media tree — a fresh drive has
   *  no write scope yet, and that scope is meant to come FROM these dirs (the
   *  catch-22 that left 115 drives stuck "目录待建"). So this is deliberately NOT
   *  `create`: `create` builds the steady-state executor bound to the provisioned
   *  CIDs, which do not exist yet here. Bounded + idempotent (find-or-create, no
   *  deletes).
   *
   *  REQUIRED. The dispatch used to end in `provider === "quark" ? registry :
   *  createBootstrapPan115CookieStorageExecutor(...)`, so a sixth COOKIE brand
   *  would have been silently handed 115's client to build its directories —
   *  exactly the G1 silent-failure class. Each brand must now say how it
   *  provisions itself. */
  createBootstrap: (input: StorageBootstrapInput) => StorageExecutor;
  /** The transfer-model note injected into the acquisition agent's prompt for a run
   *  on this drive: which link kinds can land here and how a dead one fails.
   *  Empty for 115 (it keeps the in-prompt guidance).
   *
   *  REQUIRED. It used to be four `if (provider === ...)` branches plus a silent
   *  `return ""` default in task-agents.ts, so a brand that forgot to add one got
   *  NO transfer-model guidance — the agent would operate the drive without knowing
   *  whether magnets work. The text lives in transfer-model-notes.ts (dependency-free,
   *  see the note there). */
  transferModelNote: string;
}

/** Input to a brand's `createBootstrap`. Cookie brands read `cookie`, token brands
 *  read `credential`; `env` carries the brand's own tuning knobs. */
export interface StorageBootstrapInput {
  cookie: string;
  credential?: unknown;
  env?: Record<string, string | undefined>;
}

export const STORAGE_BRANDS: StorageBrand[] = [
  {
    provider: "pan115",
    label: "115 网盘",
    parseUid: parsePan115Uid,
    isAuthError: isPan115AuthError,
    resourceProviderKinds: ["pansou-115", "prowlarr"],
    assumeChineseSubsFromChineseTitle: true,
    authKind: "cookie",
    provisionRootId: "0", // 115 account root
    writeScope: "parents",
    minApiIntervalMs: 0, // 115 client 自带 1.2s 漏桶
    deadLinksSkill: DEAD_LINKS_BLACK_BOX,
        transferModelNote: "",
    createBootstrap: ({ cookie, env }) =>
          createBootstrapPan115CookieStorageExecutor({ cookie, ...(env === undefined ? {} : { env }) }),
    create: (input) => {
      const cookie = input.cookie ?? "";
      const env = {
        ...(input.env ?? process.env),
        PAN115_COOKIE: cookie,
        ...(input.scopeCids.length > 0 ? { MEDIA_TRACK_115_WRITE_SCOPE_CIDS: input.scopeCids.join(",") } : {}),
      };
      return createProtectedPan115CookieStorageExecutorFromEnv({ env });
    },
  },
  {
    provider: "quark",
    label: "夸克网盘",
    parseUid: parseQuarkUid,
    isAuthError: isQuarkAuthError,
    resourceProviderKinds: ["pansou-quark"],
    assumeChineseSubsFromChineseTitle: true,
    authKind: "cookie",
    provisionRootId: "0", // 夸克 account root
    writeScope: "parents",
    minApiIntervalMs: 0, // 夸克 client 自带 3/s 令牌桶
    deadLinksSkill: DEAD_LINKS_BLACK_BOX_QUARK,
        transferModelNote: TRANSFER_MODEL_NOTE_QUARK,
    createBootstrap: ({ cookie }) =>
          new QuarkStorageExecutor({ client: new QuarkCookieClient({ cookie }), writeScopeDirectoryIds: [] }),
    create: (input) => {
      return new QuarkStorageExecutor({
        // P13：夸克 client 过令牌桶限速（3/s burst 5，治理文档参数）——此前完全
        // 无 pacing，是封号风险的真实缺口（115 早有 1.2s 漏桶）。
        client: withBrandPacing(new QuarkCookieClient({ cookie: input.cookie ?? "" }), "quark", {
          clock: () => Date.now(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        }),
        writeScopeDirectoryIds: input.scopeCids,
      });
    },
  },
  {
    provider: "guangya",
    label: "光鸭云盘",
    parseUid: parseGuangYaUid,
    isAuthError: isGuangYaAuthError,
    // Own share links (restore_share, 2026-09) + magnet/offline — dual path like 123.
    resourceProviderKinds: ["pansou-guangya", "pansou-magnet", "prowlarr"],
    assumeChineseSubsFromChineseTitle: false,
    authKind: "token",
    provisionRootId: "", // 光鸭 account root
    requiredCredentialKeys: ["accessToken", "refreshToken"],
    writeScope: "listed",
    minApiIntervalMs: 0,
    deadLinksSkill: DEAD_LINKS_BLACK_BOX_GUANGYA,
        transferModelNote: TRANSFER_MODEL_NOTE_GUANGYA,
    createBootstrap: ({ credential }) => {
          const c = (credential ?? {}) as { accessToken?: string; refreshToken?: string; deviceId?: string };
          const clientOptions: GuangYaClientOptions = {
            accessToken: c.accessToken ?? "",
            refreshToken: c.refreshToken ?? "",
          };
          if (c.deviceId !== undefined) {
            clientOptions.deviceId = c.deviceId;
          }
          return new GuangYaStorageExecutor({ client: new GuangYaClient(clientOptions), writeScopeDirectoryIds: [] });
        },
    create: (input) => {
      const c = (input.credential ?? {}) as {
        accessToken?: string;
        refreshToken?: string;
        deviceId?: string;
      };
      // Build options without ever setting optional keys to `undefined`
      // (exactOptionalPropertyTypes forbids it).
      const clientOptions: GuangYaClientOptions = {
        accessToken: c.accessToken ?? "",
        refreshToken: c.refreshToken ?? "",
      };
      if (c.deviceId !== undefined) {
        clientOptions.deviceId = c.deviceId;
      }
      const onRefresh = input.onCredentialRefresh;
      if (onRefresh) {
        clientOptions.onTokensRefreshed = (t) => onRefresh(t);
      }
      return new GuangYaStorageExecutor({
        client: new GuangYaClient(clientOptions),
        writeScopeDirectoryIds: input.scopeCids,
      });
    },
  },
  {
    provider: "tianyi",
    label: "天翼云盘",
    parseUid: parseTianyiUid,
    isAuthError: isTianyiAuthError,
    resourceProviderKinds: ["pansou-tianyi"],
    assumeChineseSubsFromChineseTitle: true,
    authKind: "token",
    provisionRootId: "-11", // 天翼个人云 root folder id
    requiredCredentialKeys: ["sessionKey", "accessToken", "refreshToken"],
    writeScope: "listed",
    minApiIntervalMs: 0,
    deadLinksSkill: DEAD_LINKS_BLACK_BOX_TIANYI,
        transferModelNote: TRANSFER_MODEL_NOTE_TIANYI,
    createBootstrap: ({ credential }) => {
          const c = (credential ?? {}) as Partial<TianyiCredential>;
          const clientOptions: TianyiClientOptions = {
            sessionKey: c.sessionKey ?? "",
            accessToken: c.accessToken ?? "",
            refreshToken: c.refreshToken ?? "",
          };
          if (c.familySessionKey !== undefined) {
            clientOptions.familySessionKey = c.familySessionKey;
          }
          return new TianyiStorageExecutor({ client: new TianyiClient(clientOptions), writeScopeDirectoryIds: [] });
        },
    create: (input) => {
      const c = (input.credential ?? {}) as Partial<TianyiCredential>;
      // Same exactOptionalPropertyTypes discipline as guangya: never set optional
      // keys to `undefined`.
      const clientOptions: TianyiClientOptions = {
        sessionKey: c.sessionKey ?? "",
        accessToken: c.accessToken ?? "",
        refreshToken: c.refreshToken ?? "",
      };
      if (c.familySessionKey !== undefined) {
        clientOptions.familySessionKey = c.familySessionKey;
      }
      const onRefresh = input.onCredentialRefresh;
      if (onRefresh) {
        clientOptions.onCredentialRefresh = (creds) => onRefresh(creds);
      }
      return new TianyiStorageExecutor({
        client: new TianyiClient(clientOptions),
        writeScopeDirectoryIds: input.scopeCids,
      });
    },
  },
  {
    provider: "pan123",
    label: "123网盘",
    parseUid: parsePan123Uid,
    isAuthError: isPan123AuthError,
    // Share links + native offline (magnet/ed2k) — OpenList drivers/123 OfflineDownload.
    resourceProviderKinds: ["pansou-123", "prowlarr"],
    assumeChineseSubsFromChineseTitle: true,
    authKind: "token",
    provisionRootId: "0", // 123 个人云根
    requiredCredentialKeys: ["token"],
    writeScope: "listed",
    minApiIntervalMs: 1500, // 123 用 code=100011 请勿频繁操作 回应突发
    deadLinksSkill: DEAD_LINKS_BLACK_BOX_PAN123,
        transferModelNote: TRANSFER_MODEL_NOTE_PAN123,
    createBootstrap: ({ credential }) => {
          const c = (credential ?? {}) as Partial<Pan123Credential>;
          return new Pan123StorageExecutor({ client: new Pan123Client({ token: c.token ?? "" }), writeScopeDirectoryIds: [] });
        },
    create: (input) => {
      const c = (input.credential ?? {}) as Partial<Pan123Credential>;
      // 纯 token 模型:v1 无凭证刷新(web 面无 refresh 端点,401 → Pan123AuthError
      // → registry isAuthError 冻结重扫),故不接 onCredentialRefresh。
      return new Pan123StorageExecutor({
        client: new Pan123Client({ token: c.token ?? "" }),
        writeScopeDirectoryIds: input.scopeCids,
      });
    },
  },
];

/**
 * Map a brand's resource-provider kinds to the PanSou link types its acquisitions
 * may transfer. A 夸克 drive can only save 夸克 share links; 光鸭 / 123 / 115 take
 * their OWN share links plus magnets (光鸭: restore_share + offline download).
 * Pure + brand-table-driven so the resource assembly stays testable.
 */
export function allowedResourceTypesForKinds(kinds: readonly string[]): ResourceType[] {
  if (kinds.includes("pansou-quark")) {
    return ["quark"];
  }
  if (kinds.includes("pansou-tianyi")) {
    return ["tianyi"];
  }
  // 123 share + magnet when prowlarr/pansou-magnet is also listed (dual-path brand).
  if (kinds.includes("pansou-123")) {
    return kinds.includes("prowlarr") || kinds.includes("pansou-magnet")
      ? ["123", "magnet"]
      : ["123"];
  }
  // 光鸭 share + magnet when a magnet source is also listed (dual-path brand).
  if (kinds.includes("pansou-guangya")) {
    return kinds.includes("prowlarr") || kinds.includes("pansou-magnet")
      ? ["guangya", "magnet"]
      : ["guangya"];
  }
  if (kinds.includes("pansou-magnet")) {
    return ["magnet"];
  }
  return ["115", "magnet"];
}

export function getStorageBrand(provider: string): StorageBrand {
  const brand = STORAGE_BRANDS.find((b) => b.provider === provider);
  if (!brand) {
    throw new Error(`unknown storage brand: ${provider}`);
  }
  return brand;
}

/**
 * Runtime guard for the registry's own invariant: a brand whose `create` is
 * somehow absent must fail loudly. `StorageBrand.create` is a required field, so
 * a typed caller cannot get here — this covers JS callers and `as` casts that
 * strip it. Throwing beats the old silent-failure class (G1), where an unwired
 * brand looked like "nothing happened".
 */
/** Same runtime guard for `createBootstrap` — a registered brand missing it must
 *  fail loudly. Silently falling back to another brand's bootstrap executor (which
 *  is what the old ternary did for any non-quark cookie brand) builds directories
 *  through the wrong client. */
export function buildBootstrapExecutorForBrand(
  brand: StorageBrand,
  input: StorageBootstrapInput,
): StorageExecutor {
  if (typeof brand.createBootstrap !== "function") {
    throw new Error(`storage brand registered without a bootstrap executor: ${brand.provider}`);
  }
  return brand.createBootstrap(input);
}

export function buildExecutorForBrand(brand: StorageBrand, input: StorageDriverCreateInput): StorageExecutor {
  if (typeof brand.create !== "function") {
    throw new Error(`storage brand registered without an executor: ${brand.provider}`);
  }
  return brand.create(input);
}

/** Build the protected executor for a drive's brand. Dispatch is by
 *  `connected_storages.provider`, so one account can hold a 115 drive and a quark
 *  drive side by side, each with its own write scope (the drive's category CIDs). */
export function createExecutorForBrand(input: StorageDriverCreateInput): StorageExecutor {
  const brand = STORAGE_BRANDS.find((b) => b.provider === input.provider);
  if (!brand) {
    throw new Error(`unknown storage brand: ${input.provider}`);
  }
  return buildExecutorForBrand(brand, input);
}

/** Whether a provider string names a registered brand (used to widen the old
 *  `provider==="pan115"` filters to "any registered brand"). */
export function isRegisteredStorageProvider(provider: string): provider is StorageProvider {
  return STORAGE_BRANDS.some((b) => b.provider === provider);
}

/** Whether the drive's executor writes only where it listed or created in this run
 *  (see StorageBrand.writeScope). False for unknown or missing providers. */
export function brandWritesOnlyListedDirectories(provider: string | undefined): boolean {
  return (
    provider !== undefined &&
    isRegisteredStorageProvider(provider) &&
    getStorageBrand(provider).writeScope === "listed"
  );
}

/** Whether a brand can use Prowlarr (磁力/PT) — 115 yes, 夸克 no (no magnet API).
 *  Settings hides the Prowlarr block when no connected drive supports it. Safe on
 *  unknown providers (returns false, never throws). */
export function brandSupportsProwlarr(provider: string): boolean {
  return (
    isRegisteredStorageProvider(provider) &&
    getStorageBrand(provider).resourceProviderKinds.includes("prowlarr")
  );
}

/** Display labels of every registered brand that can use Prowlarr, in registry
 *  order. Settings derives "which drives magnet works on" from this instead of a
 *  hand-written note — the old 「仅对 115 盘生效」 went stale the day 光鸭/123 gained
 *  magnet. Same source of truth as brandSupportsProwlarr. */
export function brandsSupportingProwlarr(): string[] {
  return STORAGE_BRANDS.filter((brand) => brand.resourceProviderKinds.includes("prowlarr")).map(
    (brand) => brand.label,
  );
}
