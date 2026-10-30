import { createHash } from "node:crypto";
import type { LanguageModel } from "ai";
import {
  assertWorkflowAgentAdapterPolicy,
  createAgentModel,
  createAgentModelFromEnv,
  createJevJudge,
  createStubAcquisitionModel,
  DEFAULT_JEV_BASE_URL,
  FREE_LLM_PRESET,
  isBlankEnvValue,
  isFreeLlmPreset,
  llmConfigError,
  TMDB_DIRECT_BASE_URL,
  type JevJudge,
  type TmdbAccess,
  type WorkflowRepository,
} from "@media-track/workflow";
import { isAutoUpdateTime, DEFAULT_AUTO_UPDATE_TIME } from "../auto-update-schedule";
import { resolveUserPanSouBaseUrl, DEFAULT_PANSOU_BASE_URL as PUBLIC_PANSOU_BASE_URL } from "../pansou-chain";

// Per-signature model cache (keyed by adapter|baseURL|modelId|apiKey) so multiple
// accounts with different LLM configs each keep their own built model — a single
// slot would thrash between accounts in multi-user mode.
const agentModelCache = new Map<string, ReturnType<typeof createAgentModelFromEnv>>();

export const PREFERRED_LANGUAGE_SETTING_KEY = "preferred_language";
export const QUALITY_PREFERENCE_SETTING_KEY = "quality_preference";

/** The user's preferred subtitle language for acquisition search, or undefined
 *  when unset / "any" (agent searches broadly). */
export async function getPreferredLanguage(
  repository: { getSetting(key: string): Promise<string | null> },
): Promise<string | undefined> {
  const value = (await repository.getSetting(PREFERRED_LANGUAGE_SETTING_KEY))?.trim();
  if (value === "any") {
    return undefined;
  }
  return value || "中文";
}

/** The user's acquisition quality preference, or undefined when 不限/unset
 *  (the default). undefined → inject NO quality guidance (coverage-only, current
 *  behavior). Only "high"/"medium" are honored; anything else (incl. the legacy
 *  "4K" value) is treated as 不限. */
export async function getQualityPreference(
  repository: { getSetting(key: string): Promise<string | null> },
): Promise<"high" | "medium" | undefined> {
  const value = (await repository.getSetting(QUALITY_PREFERENCE_SETTING_KEY))?.trim();
  return value === "high" || value === "medium" ? value : undefined;
}

export const LLM_BASE_URL_SETTING_KEY = "llm_base_url";
export const LLM_API_KEY_SETTING_KEY = "llm_api_key";
export const LLM_MODEL_ID_SETTING_KEY = "llm_model_id";

/** The user's configured OpenAI-compatible LLM (Settings → AI 模型). Each field is
 *  undefined when unset/blank, so `getAgentModel` cleanly falls back to .env. */
export async function getLlmConfig(repository: {
  getSetting(key: string): Promise<string | null>;
}): Promise<{ baseURL: string | undefined; apiKey: string | undefined; modelId: string | undefined }> {
  const read = async (key: string): Promise<string | undefined> => {
    const value = (await repository.getSetting(key))?.trim();
    return value ? value : undefined;
  };
  return {
    baseURL: await read(LLM_BASE_URL_SETTING_KEY),
    apiKey: await read(LLM_API_KEY_SETTING_KEY),
    modelId: await read(LLM_MODEL_ID_SETTING_KEY),
  };
}

function pickEnvValue(modern: string | undefined, legacy: string | undefined): string | undefined {
  return isBlankEnvValue(modern) ? legacy : modern;
}

function omitPresetOrUndefinedApiKey(
  apiKey: string | undefined,
  baseURL: string | undefined,
  modelId: string | undefined,
): { apiKey?: string; baseURL?: string; modelId?: string } {
  const presetValued = isFreeLlmPreset({
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(modelId === undefined ? {} : { modelId }),
  });
  return {
    ...(apiKey === undefined || presetValued ? {} : { apiKey }),
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(modelId === undefined ? {} : { modelId }),
  };
}

/** Resolve the live agent model config the SAME way the worker builds it: DB
 *  (pass an account-scoped repo) → .env (AGENT_MODEL_* with XIAOMI_MIMO_* as a
 *  back-compat fallback) → 出厂免费预设 FREE_LLM_PRESET. */
export async function resolveAgentModelConfig(
  repository: { getSetting(key: string): Promise<string | null> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ apiKey?: string; baseURL?: string; modelId?: string; source: "db" | "env" | "free-preset" }> {
  const llm = await getLlmConfig(repository);
  const apiKey = llm.apiKey ?? pickEnvValue(env.AGENT_MODEL_API_KEY, env.XIAOMI_MIMO_API_KEY);
  const baseURL = llm.baseURL ?? pickEnvValue(env.AGENT_MODEL_BASE_URL, env.XIAOMI_MIMO_BASE_URL);
  const modelId = llm.modelId ?? pickEnvValue(env.AGENT_MODEL_ID, env.XIAOMI_MIMO_MODEL_ID);
  if (isBlankEnvValue(baseURL) && isBlankEnvValue(modelId)) {
    return { ...FREE_LLM_PRESET, source: "free-preset" };
  }
  const source =
    llm.apiKey !== undefined || llm.baseURL !== undefined || llm.modelId !== undefined ? "db" : "env";
  return {
    ...omitPresetOrUndefinedApiKey(apiKey, baseURL, modelId),
    source,
  };
}

export async function getAgentModel(repository: {
  getSetting(key: string): Promise<string | null>;
}): Promise<{
  model: ReturnType<typeof createAgentModelFromEnv>;
  llmConfig: { baseURL?: string; modelId?: string };
  preferredLanguage: string | undefined;
  qualityPreference: "high" | "medium" | undefined;
}> {
  assertWorkflowAgentAdapterPolicy(process.env);
  const env = process.env;
  const adapter = env.MEDIA_TRACK_AGENT_ADAPTER === "vercel-ai" ? "vercel-ai" : "fake";
  const preferredLanguage = await getPreferredLanguage(repository);
  const qualityPreference = await getQualityPreference(repository);

  const resolved = await resolveAgentModelConfig(repository, env);
  const { apiKey, baseURL, modelId } = resolved;
  if (adapter === "vercel-ai") {
    const configError = llmConfigError(resolved);
    if (configError) {
      throw new Error(configError);
    }
  }
  const signature = `${adapter}|${baseURL ?? ""}|${modelId ?? ""}|${apiKey ?? ""}`;
  let model = agentModelCache.get(signature);
  if (!model) {
    model = adapter === "vercel-ai" ? createAgentModel(resolved) : createStubAcquisitionModel();
    agentModelCache.set(signature, model);
  }
  const llmConfig = {
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(modelId === undefined ? {} : { modelId }),
  };
  return { model, llmConfig, preferredLanguage, qualityPreference };
}

/**
 * The model the SEARCH BOX uses to interpret a description. It is the account's
 * own configured model (Settings → AI 模型), and consciously NOT the shipped
 * free preset.
 */
export async function getAgentModelForSearch(
  repository: { getSetting(key: string): Promise<string | null> },
): Promise<LanguageModel | null> {
  const resolved = await resolveAgentModelConfig(repository);
  if (resolved.source === "free-preset" || isFreeLlmPreset(resolved)) return null;
  if (llmConfigError(resolved)) return null;
  try {
    return createAgentModel(resolved);
  } catch {
    return null;
  }
}

/** Web search options for the acquisition agent. */
export async function resolveTitleResearchOptions(
  repository: { getSetting(key: string): Promise<string | null> },
): Promise<{ web: { llmBaseURL?: string; llmApiKey?: string } }> {
  const resolved = await resolveAgentModelConfig(repository);
  return {
    web: {
      ...(resolved.baseURL === undefined ? {} : { llmBaseURL: resolved.baseURL }),
      ...(resolved.apiKey === undefined ? {} : { llmApiKey: resolved.apiKey }),
    },
  };
}

export const TMDB_API_KEY_SETTING_KEY = "tmdb_api_key";
export const ASSRT_TOKEN_SETTING_KEY = "assrt_token";

export async function getAssrtToken(
  repository: { getSetting(key: string): Promise<string | null> },
): Promise<string | undefined> {
  const value = (await repository.getSetting(ASSRT_TOKEN_SETTING_KEY))?.trim();
  return value ? value : undefined;
}

export const DEFAULT_TMDB_PROXY_BASE_URL = "https://tmdb-proxy.mediaryscout.app";

export async function getTmdbAccesses(
  repository: { getSetting(key: string): Promise<string | null> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<TmdbAccess[]> {
  const accesses: TmdbAccess[] = [];
  const userKey = (await repository.getSetting(TMDB_API_KEY_SETTING_KEY))?.trim();
  if (userKey) {
    accesses.push({ baseURL: TMDB_DIRECT_BASE_URL, readToken: userKey });
  }
  const envToken = env.TMDB_READ_TOKEN?.trim();
  if (envToken) {
    accesses.push({ baseURL: TMDB_DIRECT_BASE_URL, readToken: envToken });
  }
  const proxyBase = env.TMDB_PROXY_BASE_URL?.trim() || DEFAULT_TMDB_PROXY_BASE_URL;
  accesses.push({ baseURL: proxyBase });
  return accesses;
}

export const PANSOU_BASE_URL_SETTING_KEY = "pansou_base_url";
export const PANSOU_HEALTH_SETTING_KEY = "pansou_last_probe";

export async function getPanSouBaseUrl(
  repository: { getSetting(key: string): Promise<string | null> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const configured = resolveUserPanSouBaseUrl(
    await repository.getSetting(PANSOU_BASE_URL_SETTING_KEY),
    env,
  );
  return configured || PUBLIC_PANSOU_BASE_URL;
}

export const PROWLARR_BASE_URL_SETTING_KEY = "prowlarr_base_url";
export const PROWLARR_API_KEY_SETTING_KEY = "prowlarr_api_key";

export async function getProwlarrConfig(
  repository: { getSetting(key: string): Promise<string | null> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ baseURL: string | undefined; apiKey: string | undefined }> {
  const read = async (key: string, envKey: string): Promise<string | undefined> => {
    const dbValue = (await repository.getSetting(key))?.trim();
    if (dbValue) return dbValue;
    const envValue = env[envKey]?.trim();
    return envValue ? envValue : undefined;
  };
  return {
    baseURL: await read(PROWLARR_BASE_URL_SETTING_KEY, "PROWLARR_BASE_URL"),
    apiKey: await read(PROWLARR_API_KEY_SETTING_KEY, "PROWLARR_API_KEY"),
  };
}

export const HAISOU_API_KEY_SETTING_KEY = "haisou_api_key";

export async function getHaisouApiKey(
  repository: { getSetting(key: string): Promise<string | null> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const dbValue = (await repository.getSetting(HAISOU_API_KEY_SETTING_KEY))?.trim();
  if (dbValue) return dbValue;
  const envValue = env["HAISOU_API_KEY"]?.trim();
  return envValue ? envValue : undefined;
}

export const JEV_API_KEY_SETTING_KEY = "jev_api_key";
export const JEV_BASE_URL_SETTING_KEY = "jev_base_url";
export const JEV_PREFILTER_ENABLED_SETTING_KEY = "jev_prefilter_enabled";
export const JEV_HEALTH_SETTING_KEY = "jev_health";
export const JEV_MODEL_SETTING_KEY = "jev_model";
export const JEV_PROBED_FOR_SETTING_KEY = "jev_probed_for";

export function jevConfigFingerprint(apiKey: string, baseUrl: string): string {
  return createHash("sha256").update(`${apiKey.trim()}\n${baseUrl.trim()}`).digest("hex").slice(0, 16);
}

export interface JevSettingsSource {
  getSetting(key: string): Promise<string | null>;
  getOwnSetting?(key: string): Promise<string | null>;
}

export interface JevConfig {
  apiKey: string | undefined;
  baseUrl: string;
  enabled: boolean;
  health: string | undefined;
}

async function readDbOrEnvSetting(
  repository: { getSetting(key: string): Promise<string | null> },
  env: NodeJS.ProcessEnv,
  key: string,
  envKey: string,
): Promise<string | undefined> {
  const dbValue = (await repository.getSetting(key))?.trim();
  if (dbValue) return dbValue;
  const envValue = env[envKey]?.trim();
  return envValue ? envValue : undefined;
}

async function readTrimmedSetting(
  getter: ((key: string) => Promise<string | null>) | undefined,
  key: string,
): Promise<string | undefined> {
  if (!getter) return undefined;
  const val = (await getter(key))?.trim();
  return val ? val : undefined;
}

function isJevHealthInvalidated(opts: {
  probedFor: string | undefined;
  apiKey: string | undefined;
  baseUrl: string;
  ownUrl: string | undefined;
  ownKey: string | undefined;
}): boolean {
  const stale = Boolean(opts.probedFor) && opts.probedFor !== jevConfigFingerprint(opts.apiKey ?? "", opts.baseUrl);
  const borrowedKeyAtOwnUrl = Boolean(opts.ownUrl) && !opts.ownKey;
  return stale || borrowedKeyAtOwnUrl;
}

export async function getJevConfig(
  repository: JevSettingsSource,
  env: NodeJS.ProcessEnv = process.env,
): Promise<JevConfig> {
  const apiKey = await readDbOrEnvSetting(repository, env, JEV_API_KEY_SETTING_KEY, "JEV_API_KEY");
  const baseUrl = (await readDbOrEnvSetting(repository, env, JEV_BASE_URL_SETTING_KEY, "JEV_BASE_URL")) ?? DEFAULT_JEV_BASE_URL;
  const health = await readTrimmedSetting((k) => repository.getSetting(k), JEV_HEALTH_SETTING_KEY);
  const probedFor = await readTrimmedSetting((k) => repository.getSetting(k), JEV_PROBED_FOR_SETTING_KEY);
  const ownUrl = await readTrimmedSetting(
    repository.getOwnSetting ? (k) => repository.getOwnSetting!(k) : undefined,
    JEV_BASE_URL_SETTING_KEY,
  );
  const ownKey = await readTrimmedSetting(
    repository.getOwnSetting ? (k) => repository.getOwnSetting!(k) : undefined,
    JEV_API_KEY_SETTING_KEY,
  );
  const enabledRaw = await readTrimmedSetting((k) => repository.getSetting(k), JEV_PREFILTER_ENABLED_SETTING_KEY);
  const invalidated = isJevHealthInvalidated({ probedFor, apiKey, baseUrl, ownUrl, ownKey });
  return {
    apiKey,
    baseUrl,
    enabled: enabledRaw === "1",
    health: invalidated ? undefined : health,
  };
}

export async function getJevInheritedBaseUrl(
  repo: Pick<WorkflowRepository, "getSetting">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const global = (await repo.getSetting(JEV_BASE_URL_SETTING_KEY))?.trim();
  if (global) return global;
  return env.JEV_BASE_URL?.trim() || DEFAULT_JEV_BASE_URL;
}

export function isJevPrefilterActive(cfg: JevConfig): boolean {
  return Boolean(cfg.apiKey) && cfg.enabled && cfg.health === "ok";
}

export async function resolveJevJudge(
  repository: JevSettingsSource,
  env: NodeJS.ProcessEnv = process.env,
): Promise<JevJudge | undefined> {
  const cfg = await getJevConfig(repository, env);
  if (!isJevPrefilterActive(cfg) || !cfg.apiKey) return undefined;
  return createJevJudge({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
}

export const DAILY_SWEEP_TIME_SETTING_KEY = "daily_sweep_time";
export const DEFAULT_DAILY_SWEEP_TIME = "06:00";
export const DAILY_SWEEP_TIMES_SETTING_KEY = "daily_sweep_times";
export const MAX_DAILY_SWEEP_TIMES = 6;
export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function getDailySweepTime(
  repository: { getSetting(key: string): Promise<string | null> },
): Promise<string> {
  const value = (await repository.getSetting(DAILY_SWEEP_TIME_SETTING_KEY))?.trim();
  return value && HHMM_RE.test(value) ? value : DEFAULT_DAILY_SWEEP_TIME;
}

export const PATROL_CONCURRENCY_SETTING_KEY = "patrol_max_concurrent_runs";
export const DEFAULT_PATROL_CONCURRENCY = 1;
export const MAX_PATROL_CONCURRENCY = 5;

export async function getPatrolConcurrency(
  repository: { getSetting(key: string): Promise<string | null> },
): Promise<number> {
  const value = Number((await repository.getSetting(PATROL_CONCURRENCY_SETTING_KEY))?.trim());
  return Number.isInteger(value) && value >= 1 && value <= MAX_PATROL_CONCURRENCY ? value : DEFAULT_PATROL_CONCURRENCY;
}

export async function getDailySweepTimes(
  repository: { getSetting(key: string): Promise<string | null> },
): Promise<string[]> {
  const raw = (await repository.getSetting(DAILY_SWEEP_TIMES_SETTING_KEY))?.trim();
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const valid = [...new Set(parsed.filter((t): t is string => typeof t === "string" && HHMM_RE.test(t)))]
          .sort()
          .slice(0, MAX_DAILY_SWEEP_TIMES);
        if (valid.length > 0) return valid;
      }
    } catch {
      // 烂 JSON 走回退
    }
  }
  return [await getDailySweepTime(repository)];
}

export const LAST_SWEEP_DATE_SETTING_KEY = "last_sweep_date";
export const LAST_SWEEP_CLAIMS_SETTING_KEY = "last_sweep_claims";
export const LAST_SWEEP_COMPLETED_AT_SETTING_KEY = "last_sweep_completed_at";

interface SweepClaims {
  date: string;
  slots: string[];
}

/** Beijing wall-clock "date" (YYYY-MM-DD) and "HH:MM" right now. */
export function beijingDateTime(): { date: string; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hhmm: `${get("hour")}:${get("minute")}` };
}

export async function readSweepClaims(
  repository: { getSetting(key: string): Promise<string | null> },
  today: string,
): Promise<string[]> {
  const raw = (await repository.getSetting(LAST_SWEEP_CLAIMS_SETTING_KEY))?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<SweepClaims>;
      if (parsed.date === today && Array.isArray(parsed.slots)) {
        return [...new Set(parsed.slots.filter((slot): slot is string => typeof slot === "string" && HHMM_RE.test(slot)))].sort();
      }
    } catch {
      // 烂 JSON 当无认领
    }
    return [];
  }
  const legacyDate = (await repository.getSetting(LAST_SWEEP_DATE_SETTING_KEY))?.trim();
  if (legacyDate === today) {
    const times = await getDailySweepTimes(repository);
    const { hhmm } = beijingDateTime();
    return times.filter((slot) => hhmm >= slot);
  }
  return [];
}

export const AUTO_UPDATE_ENABLED_SETTING_KEY = "auto_update_enabled";
export const AUTO_UPDATE_TIME_SETTING_KEY = "auto_update_time";
export const AUTO_UPDATE_LAST_ATTEMPT_SETTING_KEY = "auto_update_last_attempt";
export const AUTO_UPDATE_FAIL_STREAK_SETTING_KEY = "auto_update_fail_streak";

export async function isAutoUpdateEnabled(repository: { getSetting(key: string): Promise<string | null> }): Promise<boolean> {
  return (await repository.getSetting(AUTO_UPDATE_ENABLED_SETTING_KEY))?.trim() === "1";
}

export async function getAutoUpdateTime(repository: { getSetting(key: string): Promise<string | null> }): Promise<string> {
  const time = (await repository.getSetting(AUTO_UPDATE_TIME_SETTING_KEY))?.trim();
  return time && isAutoUpdateTime(time) ? time : DEFAULT_AUTO_UPDATE_TIME;
}

export async function getAutoUpdateSettings(
  repository: { getSetting(key: string): Promise<string | null> },
): Promise<{ enabled: boolean; time: string }> {
  return { enabled: await isAutoUpdateEnabled(repository), time: await getAutoUpdateTime(repository) };
}

export interface AutoUpdateFailStreak {
  tag: string;
  count: number;
  at: string;
}

export function parseAutoUpdateFailStreak(raw: string | null): AutoUpdateFailStreak | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AutoUpdateFailStreak> | null;
    if (
      parsed &&
      typeof parsed.tag === "string" &&
      typeof parsed.count === "number" &&
      Number.isInteger(parsed.count) &&
      parsed.count > 0
    ) {
      return { tag: parsed.tag, count: parsed.count, at: typeof parsed.at === "string" ? parsed.at : "" };
    }
  } catch {
    // A hand-edited or damaged value counts as no failures.
  }
  return null;
}
