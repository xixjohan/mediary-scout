import { parseGuangYaShareUrl } from "./guangya-client.js";
import { parseQuarkShareUrl, parseUcShareUrl } from "./quark-storage-executor.js";
import { parsePan123ShareUrl } from "./pan123-storage-executor.js";
import { parseTianyiShareUrl } from "./tianyi-storage-executor.js";
import { createHash } from "node:crypto";
import type {
  ResourceCandidate,
  ResourceSnapshot,
  ResourceType,
} from "./domain.js";
import type { ResourceProvider } from "./ports.js";
import {
  classifySourceFailure,
  mergeSourceHealth,
  PanSouAuthError,
  PanSouProtocolError,
  PanSouRequestError,
  type SourceHealth,
} from "./resource-source-health.js";

export interface PanSouFetchInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  /** Per-request abort deadline — a stalled PanSou upstream must degrade to
   *  "fewer candidates this poll", never hang the run (2026-07-06 incident:
   *  4.5 min pre-agent stall; same failure class as the TMDB hang #68).
   *  Optional so existing PanSouFetchJson call sites stay source-compatible;
   *  defaultFetchJson falls back to DEFAULT_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/** PanSou searches in progress per server, across every provider in this process.
 *  One PanSou fans each search out to dozens of channels and starts answering 502
 *  at about four simultaneous searches (measured 2026-09-25); parallel patrol runs
 *  share it, so their searches queue here instead of failing as "source down". */
const MAX_IN_FLIGHT_PER_SERVER = 2;
const serverSlots = new Map<string, { inFlight: number; waiters: Array<() => void> }>();

async function withServerSlot<T>(baseURL: string, call: () => Promise<T>): Promise<T> {
  let slot = serverSlots.get(baseURL);
  if (!slot) {
    slot = { inFlight: 0, waiters: [] };
    serverSlots.set(baseURL, slot);
  }
  if (slot.inFlight >= MAX_IN_FLIGHT_PER_SERVER) {
    await new Promise<void>((resolve) => slot!.waiters.push(resolve));
  } else {
    slot.inFlight += 1;
  }
  try {
    return await call();
  } finally {
    // Hand the slot straight to the next waiter (inFlight unchanged), or free it.
    const next = slot.waiters.shift();
    if (next) next();
    else if ((slot.inFlight -= 1) === 0) serverSlots.delete(baseURL);
  }
}

export type PanSouFetchJson = (url: string, init: PanSouFetchInit) => Promise<unknown>;

/** 登录换令牌。与 PanSouFetchJson 同形制但单独可注入：登录响应的形状
 *  （`{token, expires_at, username}`）与搜索响应（`{code, message, data}`）毫无
 *  关系，共用一条路径就得在每个调用点分辨「这是登录还是搜索」。分开之后，
 *  「登录发了什么」与「搜索带了什么头」可以各用一个记录数组断言。 */
export type PanSouLoginJson = (url: string, init: PanSouFetchInit) => Promise<unknown>;

/** PanSou 实例的认证形态。缺省 = 该实例没开认证（官方公共源的常态）。 */
export type PanSouAuth =
  /** 无需认证。显式表达「我知道这台不用认证」，便于与「忘了配」区分。 */
  | { kind: "none" }
  /** 用户直接粘贴的 JWT。适用于不方便交出登录密码的共用实例；过期后需人工更换。 */
  | { kind: "bearer"; token: string }
  /** 用户名 + 密码，运行时自行登录换 JWT 并缓存。 */
  | { kind: "login"; username: string; password: string };

/** 缓存里的一条令牌。expiresAt 是 epoch **毫秒**（登录响应给的是秒，入库前换算）。 */
export interface PanSouCachedToken {
  token: string;
  expiresAt: number;
}

/** 令牌缓存。默认实现是模块级 Map —— getWorkerResourceProvider 每次调用都新建
 *  provider，缓存放在实例里等于没有缓存（每次搜索都要重新登录一次）。 */
export interface PanSouTokenCache {
  get(key: string): PanSouCachedToken | undefined;
  set(key: string, token: PanSouCachedToken): void;
}

/** 距过期还有这么多毫秒就开始重登。 PanSou 默认 24h 过期；一次搜索可能跑几十秒，
 *  不留余量就会有一次搜索拿着临期令牌出门、中途失效。 */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

/** fish2018/pansou api/router.go：登录/登出/health 是公开路径，其余全要 Bearer。 */
const PANSOU_LOGIN_PATH = "/api/auth/login";

const defaultTokenCache = new Map<string, PanSouCachedToken>();

/** 登录的兜底实现。与 defaultFetchJson 分开，因为失败的可判定性要求不同：
 *  搜索失败只需知道「这次没拿到」，登录失败必须能把服务端的原话（401 密码错、
 *  403 认证功能未启用）带给用户，所以要读 body。 */
async function defaultLoginJson(url: string, init: PanSouFetchInit): Promise<unknown> {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new PanSouAuthError(`PanSou 登录返回 HTTP ${response.status}：${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PanSouAuthError(`PanSou 登录响应不是 JSON：${text.slice(0, 200)}`);
  }
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

export interface PanSouResourceProviderOptions {
  baseURL: string;
  // `| undefined` 是给 apps/web 的 exactOptionalPropertyTypes 用的：那里的 tsconfig
  // 比本包严格，`{ auth: maybeUndefined }` 这种传法在严格模式下要显式允许 undefined。
  fetchJson?: PanSouFetchJson | undefined;
  /** 这台 PanSou 要不要认证、怎么认证。缺省视为无需认证。 */
  auth?: PanSouAuth | undefined;
  /** 登录换令牌的出口。测试注入假实现；生产走 defaultLoginJson。 */
  loginJson?: PanSouLoginJson | undefined;
  /** 令牌缓存。测试必须注入全新实例，否则模块级默认缓存会串味。 */
  tokenCache?: PanSouTokenCache | undefined;
  now?: () => string;
  /** How many times to re-query before treating the result set as complete. */
  maxSearchAttempts?: number;
  /** Delay between completeness polls (ms). */
  searchPollMs?: number;
  /** Injectable sleep (tests pass a no-op). */
  wait?: (ms: number) => Promise<void>;
  /** Abort a single search request after this many ms (default 20s). */
  requestTimeoutMs?: number;
  /** Restrict returned candidates to these link types (per-brand: a quark drive
   *  gets ["quark"], a 115 drive ["115","magnet"]). Undefined = no filter. */
  allowedTypes?: ResourceType[];
}

interface PanSouLinkFact {
  title: string;
  source: string;
  type: ResourceType;
  rawType: string;
  url: string;
  password: string;
  datetime: string;
}

export class PanSouResourceProvider implements ResourceProvider {
  private readonly baseURL: string;
  private readonly fetchJson: PanSouFetchJson;
  private readonly auth: PanSouAuth | undefined;
  private readonly loginJson: PanSouLoginJson;
  private readonly tokenCache: PanSouTokenCache;
  private readonly now: () => string;
  private readonly maxSearchAttempts: number;
  private readonly searchPollMs: number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly allowedTypes: Set<ResourceType> | null;
  private readonly requestTimeoutMs: number;

  constructor(options: PanSouResourceProviderOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/, "");
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.auth = options.auth;
    this.loginJson = options.loginJson ?? defaultLoginJson;
    this.tokenCache = options.tokenCache ?? defaultTokenCache;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxSearchAttempts = options.maxSearchAttempts ?? 4;
    this.searchPollMs = options.searchPollMs ?? 2500;
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.allowedTypes = options.allowedTypes ? new Set(options.allowedTypes) : null;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * 解析本次搜索要带的认证头。空对象 = 不带 Authorization。
   *
   * 登录形态在这里完成「缓存未命中或临期 → 登录 → 落缓存」。登录放在搜索之前，
   * 所以第一次搜索永远带着有效令牌出门，不会先裸奔一次再补。
   */
  private async authHeaders(): Promise<Record<string, string>> {
    const auth = this.auth;
    if (!auth || auth.kind === "none") {
      return {};
    }
    if (auth.kind === "bearer") {
      return { Authorization: `Bearer ${auth.token}` };
    }
    const key = `${this.baseURL}|${auth.username}`;
    const cached = this.tokenCache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt - now > TOKEN_REFRESH_MARGIN_MS) {
      return { Authorization: `Bearer ${cached.token}` };
    }
    const fresh = await this.login(auth);
    this.tokenCache.set(key, fresh);
    return { Authorization: `Bearer ${fresh.token}` };
  }

  /** POST /api/auth/login 换 JWT。任何失败都升级成 PanSouAuthError —— 它必须在
   *  pollSearch 与 FallbackResourceProvider 两层都穿透，不能被折成 unreachable。 */
  private async login(auth: {
    kind: "login";
    username: string;
    password: string;
  }): Promise<PanSouCachedToken> {
    let payload: unknown;
    try {
      payload = await this.loginJson(`${this.baseURL}${PANSOU_LOGIN_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "clawd-media-track/1.0",
        },
        body: JSON.stringify({ username: auth.username, password: auth.password }),
        timeoutMs: this.requestTimeoutMs,
      });
    } catch (error) {
      // defaultLoginJson 已经抛的是 PanSouAuthError，别再包一层。
      if (error instanceof PanSouAuthError) throw error;
      throw new PanSouAuthError(
        `PanSou 登录请求失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const record = isRecord(payload) ? payload : {};
    const token = stringValue(record["token"]);
    if (!token) {
      throw new PanSouAuthError(
        `PanSou 登录响应缺少 token 字段：${JSON.stringify(payload).slice(0, 200)}`,
      );
    }
    const expiresAtSeconds = numberValue(record["expires_at"]);
    // 缺 expires_at 或它不是数字 → 视为立刻过期：下次搜索必重登。绝不因为
    // 「不知道何时过期」就无限期缓存一个可能已经失效的令牌。
    const expiresAt =
      Number.isFinite(expiresAtSeconds) && expiresAtSeconds > 0
        ? expiresAtSeconds * 1000
        : Date.now();
    return { token, expiresAt };
  }

  private async fetchFacts(keyword: string): Promise<PanSouLinkFact[]> {
    const response = await this.fetchJson(`${this.baseURL}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "clawd-media-track/1.0",
        ...(await this.authHeaders()),
      },
      body: JSON.stringify({ kw: keyword, res: "all" }),
      timeoutMs: this.requestTimeoutMs,
    });
    // 两种「不是成功响应」必须区分,否则用户拿到错误的处置建议(Copilot 评审):
    //  1. 响应带 code 字段 → 它**是** PanSou,只是报了错(限流/参数错)。
    //     那是源侧的临时故障,不是「地址填错了」,不归 PanSouProtocolError。
    //  2. 完全不是 PanSou 的形状(静态文件服务器 / 反代错误页 / 换了协议)
    //     → 地址指错了地方,这才是 PanSouProtocolError。
    if (isPanSouErrorResponse(response)) {
      throw new PanSouRequestError(`PanSou 返回错误: ${JSON.stringify(response).slice(0, 200)}`);
    }
    if (!isPanSouSuccessResponse(response)) {
      throw new PanSouProtocolError(`not a PanSou payload from ${this.baseURL}`);
    }
    const facts = collectLinkFacts(response.data.results ?? []);
    // Per-brand filter: a quark drive only sees quark links; a 115 drive only
    // sees 115/magnet. Keeps a candidate set that its executor can actually transfer.
    return this.allowedTypes ? facts.filter((fact) => this.allowedTypes!.has(fact.type)) : facts;
  }

  async search(input: { keyword: string; workflowRunId?: string }): Promise<ResourceSnapshot> {
    // The slot covers the whole poll loop, not each request: between polls PanSou
    // is still fanning the search out to its channels, which is the load that 502s.
    return withServerSlot(this.baseURL, () => this.pollSearch(input));
  }

  private async pollSearch(input: { keyword: string; workflowRunId?: string }): Promise<ResourceSnapshot> {
    // PanSou is async/streaming: the first call returns quick cached results and
    // async-plugin results land on LATER calls (5 → 35 115-links, 0 → 419
    // magnets). Poll until the link count stops growing so the agent always
    // judges the COMPLETE evidence — never a partial slice (no 抢跑). Speed comes
    // from the agent issuing FEWER searches, not from cutting this short.
    let facts: PanSouLinkFact[] = [];
    let failure: unknown = null;
    for (let attempt = 0; attempt < this.maxSearchAttempts; attempt += 1) {
      let next: PanSouLinkFact[];
      try {
        next = await this.fetchFacts(input.keyword);
      } catch (error) {
        // 认证失败不是「源临时不可用」，是「我们没资格进这道门」，必须原样抛出。
        // 吞成 sourceHealth 会让它被 classifySourceFailure 折成 unreachable，而
        // FallbackResourceProvider 正是靠那个信号降级到官方源 —— 于是一次配错凭据的
        // 自建源会靠公共源静默续命，用户永远看不到「认证失败」这四个字。
        if (error instanceof PanSouAuthError) {
          throw error;
        }
        // 只有「一条证据都没拿到」才算源不可用。中途失败但先前已有结果时,
        // 保留旧行为(保住已拿到的最完整集合)——那不是源挂了,是轮询被打断。
        failure = error;
        break;
      }
      if (next.length > facts.length) {
        facts = next;
      } else if (attempt > 0) {
        break; // stabilized: no new links since the previous poll
      }
      if (attempt < this.maxSearchAttempts - 1) {
        await this.wait(this.searchPollMs);
      }
    }
    const health: SourceHealth =
      failure !== null && facts.length === 0
        ? { status: classifySourceFailure(failure), source: "pansou" }
        : { status: "healthy", source: "pansou" };
    const snapshotId = createSnapshotId(input.keyword, facts, input.workflowRunId);
    const candidates: ResourceCandidate[] = facts.map((fact, index) => ({
      id: `${snapshotId}_candidate_${index + 1}`,
      snapshotId,
      index,
      title: fact.title,
      type: fact.type,
      source: fact.source,
      providerPayload: {
        url: fact.url,
        password: fact.password,
        datetime: fact.datetime,
        rawType: fact.rawType,
      },
    }));

    return {
      id: snapshotId,
      provider: "pansou",
      keyword: input.keyword,
      candidates,
      createdAt: this.now(),
      sourceHealth: mergeSourceHealth([health]),
    };
  }
}

export function createPanSouResourceProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PanSouResourceProvider {
  const baseURL = env.PANSOU_BASE_URL;
  if (!baseURL) {
    throw new Error("PANSOU_BASE_URL is required to create PanSouResourceProvider");
  }
  return new PanSouResourceProvider({ baseURL });
}

async function defaultFetchJson(url: string, init: PanSouFetchInit): Promise<unknown> {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`PanSou search failed with HTTP ${response.status}`);
  }
  return response.json();
}

/** 响应带 code 字段 = 它按 PanSou 协议应答了,只是没成功(限流/参数错/服务端错)。
 *  与「根本不是 PanSou」的关键区别:后者没有 code 字段。 */
function isPanSouErrorResponse(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value["code"] === "number" && value["code"] !== 0;
}

/** PanSou `SearchResponse` data (fish2018/pansou model/response.go). `Results` is
 *  tagged `json:"results,omitempty"`, so a search with ZERO hits serialises as
 *  `{"code":0,"message":"success","data":{"total":0}}` — no `results` key at all
 *  (verified live 2026-09-19 on the self-hosted container and so.252035.xyz).
 *
 *  Rule, in order:
 *   1. a PRESENT `results` must be an array — a numeric `total` never excuses a
 *      malformed one (an object would blow up `for...of` and be misread as
 *      「源挂了」; a string would iterate silently and look like a healthy miss);
 *      `null` counts as absent (encoding/json writes null for a nil slice on a
 *      build without omitempty);
 *   2. with `results` absent, a numeric `total` is the zero-hit signature;
 *   3. anything else is not PanSou.
 *
 *  Exported so the settings-page save probe applies the SAME rule: the two
 *  drifting apart is exactly how a probe could persist an address the provider
 *  then cannot consume (Copilot, #259). */
export function isPanSouSearchData(
  data: unknown,
): data is { results?: unknown[] | null; total?: number } {
  if (!isRecord(data)) return false;
  const results = data["results"];
  if (results !== undefined && results !== null) {
    return Array.isArray(results);
  }
  return typeof data["total"] === "number";
}

function isPanSouSuccessResponse(value: unknown): value is {
  code: 0;
  data: {
    results?: unknown[] | null;
    total?: number;
  };
} {
  if (!isRecord(value) || value["code"] !== 0) {
    return false;
  }
  // Treating the zero-hit shape as "not a PanSou payload" turned every honest
  // miss into a false 「搜索源连不上」 alert (2026-09-07 → 09-19, daily patrol).
  return isPanSouSearchData(value["data"]);
}

function collectLinkFacts(results: unknown[]): PanSouLinkFact[] {
  const facts: PanSouLinkFact[] = [];
  const seenUrls = new Set<string>();

  for (const result of results) {
    if (!isRecord(result)) {
      continue;
    }
    const title = stringValue(result["title"]);
    const source = stringValue(result["channel"]);
    const links = Array.isArray(result["links"]) ? result["links"] : [];
    for (const link of links) {
      if (!isRecord(link)) {
        continue;
      }
      const rawType = stringValue(link["type"]);
      const url = stringValue(link["url"]);
      const type = normalizeResourceType(rawType, url);
      if (!type || !url || seenUrls.has(url)) {
        continue;
      }
      seenUrls.add(url);
      facts.push({
        title,
        source,
        type,
        rawType,
        url,
        password: stringValue(link["password"]),
        datetime: stringValue(link["datetime"]),
      });
    }
  }

  return facts;
}

/** Classify one upstream link by its URL SHAPE.
 *
 *  The declared `rawType` is deliberately ignored. Every branch here validates the
 *  URL through the same parser its executor transfers with, so `rawType` would add
 *  no information — but it used to be able to SUBTRACT: a link tagged `"115"` whose
 *  url was a quark share hit the 115 branch, failed the shape check, and returned
 *  null before the quark parser ever ran. Checking shapes in order is both simpler
 *  and strictly more forgiving of a mislabelled upstream.
 *
 *  `_rawType` is kept in the signature so both providers call it the same way. */
export function normalizeResourceType(_rawType: string, url: string): ResourceType | null {
  // Magnets first, regardless of any declared brand: a magnet is transferable by
  // whichever drive has 秒传, and every executor routes on candidate.type ===
  // "magnet". Checking brands first would drop every 115-sourced torrent.
  if (url.startsWith("magnet:")) {
    return "magnet";
  }
  // 115 shares live on 115.com/s/<code> or 115cdn.com/s/<code> — the exact
  // prefixes storage-115-executor will transfer.
  if (/^https?:\/\/(?:www\.)?115(?:cdn)?\.com\/s\/[A-Za-z0-9]+/.test(url)) {
    return "115";
  }
  // Each of these is the SAME parser the executor transfers with, so a lookalike
  // host (evilpan.quark.cn, evil.example.com/pan.quark.cn/s/x) can never become a
  // candidate that then fails as unparseable at transfer time.
  if (parseQuarkShareUrl(url) !== null) {
    return "quark";
  }
  if (parseUcShareUrl(url) !== null) {
    return "uc";
  }
  // 123 share shapes: multi-mirror domains 123pan/123684/123865/123912 · com/cn,
  // path /s/<key>.
  if (parsePan123ShareUrl(url) !== null) {
    return "123";
  }
  // 天翼: cloud.189.cn/t/<code> and cloud.189.cn/web/share?…code=<code>.
  if (parseTianyiShareUrl(url) !== null) {
    return "tianyi";
  }
  if (parseGuangYaShareUrl(url) !== null) {
    return "guangya";
  }
  return null;
}

function createSnapshotId(keyword: string, facts: PanSouLinkFact[], workflowRunId?: string): string {
  // The keyword is part of the top-level material (not only embedded per-fact),
  // so an EMPTY result set still yields a keyword-specific id. Otherwise every
  // empty search hashes the same `[]` → one shared id that collides across
  // keywords AND across runs (resource_snapshots.id is a global primary key).
  const material = JSON.stringify({
    workflowRunId: workflowRunId ?? null,
    keyword,
    facts: facts.map((fact) => ({
      title: fact.title,
      type: fact.type,
      rawType: fact.rawType,
      url: fact.url,
      password: fact.password,
      datetime: fact.datetime,
      source: fact.source,
    })),
  });
  const hash = createHash("sha1").update(material).digest("hex").slice(0, 12);
  // Run-scope the id so a re-acquisition with identical results gets its OWN
  // snapshot row instead of colliding with the first run's on the global PK.
  return workflowRunId ? `pansou_${workflowRunId}_${hash}` : `pansou_${hash}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
