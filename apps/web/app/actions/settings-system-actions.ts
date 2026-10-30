"use server";

import { revalidatePath } from "next/cache";
import type { PanSouAuth } from "@media-track/workflow";
import { assertNotDemo } from "../../lib/demo-mode";

export interface PushSettingsActionResult {
  success: boolean;
  message?: string;
  sentTo?: string[];
}

export async function savePushSettingsAction(
  settings: Record<string, string>,
): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, getCurrentAccountId } = await import("../../lib/workflow-runtime");
    const repository = getWorkflowRepository();
    const accountId = await getCurrentAccountId();

    const keys = ["bark", "serverchan", "wecom", "webhook"];
    for (const key of keys) {
      const value = settings[key]?.trim();
      // Only write channels the user actually typed into. An empty field means
      // "leave unchanged" — the saved key stays masked and intact, never wiped.
      // Per-account (the worker reads each notification's account push config via
      // the scoped facade: account → global → env).
      if (value) {
        await repository.setAccountSetting(accountId, `push_${key}`, value);
      }
    }
    
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

const PUSH_CHANNEL_KEYS = ["bark", "serverchan", "wecom", "webhook"] as const;

/**
 * Wipe a saved push channel. Empty-on-save means "leave unchanged" (so a masked
 * key is never clobbered), which left no way to REMOVE a channel — this is that
 * affordance. Storing "" makes the channel read back as unconfigured.
 */
export async function clearPushChannelAction(key: string): Promise<PushSettingsActionResult> {
  assertNotDemo();
  if (!(PUSH_CHANNEL_KEYS as readonly string[]).includes(key)) {
    return { success: false, message: "未知的推送渠道" };
  }
  try {
    const { getWorkflowRepository, getCurrentAccountId } = await import("../../lib/workflow-runtime");
    await getWorkflowRepository().setAccountSetting(await getCurrentAccountId(), `push_${key}`, "");
    return { success: true };
  } catch (error) {
    return { success: false, message: `清除失败：${String(error)}` };
  }
}

export async function saveDailySweepTimesAction(times: string[]): Promise<PushSettingsActionResult> {
  assertNotDemo();
  if (!Array.isArray(times) || times.length === 0) {
    return { success: false, message: "至少保留一个时间点" };
  }
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  // trim 后逐项校验；任何一项非法就整体拒绝——静默丢弃会让「已保存」和实际
  // 存储不一致（自定义客户端发脏值时尤其误导）。
  const trimmed = times.map((t) => (typeof t === "string" ? t.trim() : ""));
  if (trimmed.some((t) => !HHMM.test(t))) {
    return { success: false, message: "时间格式应为 HH:MM" };
  }
  const clean = [...new Set(trimmed)].sort();
  try {
    const { getWorkflowRepository, DAILY_SWEEP_TIMES_SETTING_KEY, MAX_DAILY_SWEEP_TIMES } = await import(
      "../../lib/workflow-runtime"
    );
    if (clean.length > MAX_DAILY_SWEEP_TIMES) {
      return { success: false, message: `最多 ${MAX_DAILY_SWEEP_TIMES} 个时间点` };
    }
    await getWorkflowRepository().setSetting(DAILY_SWEEP_TIMES_SETTING_KEY, JSON.stringify(clean));
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

export async function savePatrolConcurrencyAction(value: number): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, PATROL_CONCURRENCY_SETTING_KEY, MAX_PATROL_CONCURRENCY } = await import(
      "../../lib/workflow-runtime"
    );
    if (!Number.isInteger(value) || value < 1 || value > MAX_PATROL_CONCURRENCY) {
      return { success: false, message: `只能是 1 到 ${MAX_PATROL_CONCURRENCY}` };
    }
    await getWorkflowRepository().setSetting(PATROL_CONCURRENCY_SETTING_KEY, String(value));
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

/** 手动触发一次全量巡检（force：跑完整 sweep 但不认领定时 slot，run-now 不吞计划）。 */
export async function runPatrolNowAction(): Promise<PushSettingsActionResult & { checked?: number }> {
  assertNotDemo();
  try {
    const { runScheduledType3 } = await import("../../lib/workflow-runtime");
    const result = await runScheduledType3({ force: true });
    if (result.skipped === "update_in_progress") {
      return { success: false, message: "正在更新，更新完成后再巡检。" };
    }
    return { success: true, checked: result.outcomes.length };
  } catch (error) {
    return { success: false, message: `巡检失败：${String(error)}` };
  }
}

export async function savePreferredLanguageAction(
  language: string,
): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, getCurrentAccountId, PREFERRED_LANGUAGE_SETTING_KEY } = await import(
      "../../lib/workflow-runtime"
    );
    const repository = getWorkflowRepository();
    await repository.setAccountSetting(await getCurrentAccountId(), PREFERRED_LANGUAGE_SETTING_KEY, language.trim());
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

export async function saveQualityPreferenceAction(
  quality: string,
): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, getCurrentAccountId, QUALITY_PREFERENCE_SETTING_KEY } = await import(
      "../../lib/workflow-runtime"
    );
    const repository = getWorkflowRepository();
    await repository.setAccountSetting(await getCurrentAccountId(), QUALITY_PREFERENCE_SETTING_KEY, quality.trim());
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

export async function saveLlmConfigAction(input: {
  baseURL: string;
  modelId: string;
  apiKey: string;
}): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { normalizeLlmBaseUrl, sanitizeLlmApiKey } = await import("@media-track/workflow");
    const {
      getWorkflowRepository,
      getCurrentAccountId,
      LLM_BASE_URL_SETTING_KEY,
      LLM_MODEL_ID_SETTING_KEY,
      LLM_API_KEY_SETTING_KEY,
    } = await import("../../lib/workflow-runtime");
    const repository = getWorkflowRepository();
    const accountId = await getCurrentAccountId();
    // Normalize base URL (the provider appends /chat/completions itself) and
    // strip all whitespace/invisible chars from the key — paste contamination
    // would otherwise silently store a wrong value (大误会).
    const baseURL = normalizeLlmBaseUrl(input.baseURL);
    // 清空服务地址 = 放弃自定义配置：没有 baseURL 的 modelId 无意义，留着只会
    // 制造半截行 —— resolveAgentModelConfig 对「url/model 双空」回落出厂免费预设
    // （apiKey 不参与判定，见其注释），半截配置照原样返回、下游 llmConfigError
    // fail-fast。所以 baseURL 为空时把 modelId 一并写空（整行清空 → 解析层回落
    // Kilo 免费池，残留 key 也会被回落分支丢弃），让设置页「清空地址保存即恢复
    // 默认」的文案为真（免费态表单预填预设值，用户通常只清地址）。baseURL 非空
    // 时行为不变：modelId 照用户输入（trim）存。API Key 语义不动（blank-keep，
    // 见下）。
    await repository.setAccountSetting(accountId, LLM_BASE_URL_SETTING_KEY, baseURL);
    await repository.setAccountSetting(accountId, LLM_MODEL_ID_SETTING_KEY, baseURL ? input.modelId.trim() : "");
    // Only overwrite the key when the user actually typed a new one — a blank
    // submit keeps the stored key (the form never echoes it back).
    const apiKey = sanitizeLlmApiKey(input.apiKey);
    if (apiKey) {
      await repository.setAccountSetting(accountId, LLM_API_KEY_SETTING_KEY, apiKey);
    }
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

/** 一键换回出厂免费模型：把 FREE_LLM_PRESET 写进本账号 settings（与
 *  saveLlmConfigAction 同一落点），让生效配置立即回到出厂免费档。已存的
 *  API Key 不动 —— 免费池无 key 直连用不到它，用户以后再换成自己的服务时
 *  key 还在（与 saveLlmConfigAction 的 blank-keep 语义一致）。 */
export async function restoreFreeLlmAction(): Promise<PushSettingsActionResult> {
  assertNotDemo();
  // 覆盖前记旧值，用于失败时的补偿回滚：两次 setSetting（baseURL、modelId）之间
  // 若第二次失败，baseURL 已是 Kilo、modelId 仍旧值 —— 持续生效的混合配置，用户
  // 不重试就不会自愈。选补偿回滚而非 repository 事务：现有 repository 只有逐 key
  // setSetting，为这相邻两次写加批量事务 API 超出本 PR 范围；两次写之间失败概率
  // 极低，回滚已把后果从「持续混合配置」降为「无变化」。undefined = 连旧值都没
  // 读到（import/账号解析就失败，第一写从未发生）→ 没有可回滚的状态，别乱写库。
  let previousBaseUrl: string | null | undefined;
  try {
    const { FREE_LLM_PRESET, normalizeLlmBaseUrl } = await import("@media-track/workflow");
    const { getWorkflowRepository, getCurrentAccountId, LLM_BASE_URL_SETTING_KEY, LLM_MODEL_ID_SETTING_KEY } =
      await import("../../lib/workflow-runtime");
    const repository = getWorkflowRepository();
    const accountId = await getCurrentAccountId();
    previousBaseUrl = await repository.getAccountSetting(accountId, LLM_BASE_URL_SETTING_KEY);
    // baseURL 走与 saveLlmConfigAction 相同的 normalize，保证写库值与
    // resolveAgentModelConfig 回落形态逐字一致（isFreeLlmPreset 按此比较）。
    await repository.setAccountSetting(accountId, LLM_BASE_URL_SETTING_KEY, normalizeLlmBaseUrl(FREE_LLM_PRESET.baseURL));
    await repository.setAccountSetting(accountId, LLM_MODEL_ID_SETTING_KEY, FREE_LLM_PRESET.modelId);
    return { success: true };
  } catch (error) {
    // 第一写之后失败 → best-effort 把 baseURL 写回旧值。旧值为 null（从未配置）
    // 时写空串：getLlmConfig 把空串归一为 undefined，与 null 等价（saveLlmConfigAction
    // 的「整行清空」同一语义）。回滚自身失败只进日志，绝不掩盖/替换原始错误。
    if (previousBaseUrl !== undefined) {
      try {
        const { getWorkflowRepository, getCurrentAccountId, LLM_BASE_URL_SETTING_KEY } = await import(
          "../../lib/workflow-runtime"
        );
        await getWorkflowRepository().setAccountSetting(
          await getCurrentAccountId(),
          LLM_BASE_URL_SETTING_KEY,
          previousBaseUrl ?? "",
        );
      } catch (rollbackError) {
        console.error(
          `[restore-free-llm-action] rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    // 内部细节（DB 报错、堆栈、路径）不回传浏览器 —— 与 web 端 runAction 的
    // 泛化错误边界同一思路（那边也是刻意丢掉异常只给固定文案）。原始错误进
    // 服务端日志供排查。
    console.error(`[restore-free-llm-action] failed: ${error instanceof Error ? error.message : String(error)}`);
    return { success: false, message: "换回失败，请稍后重试" };
  }
}

export async function testLlmConnectionAction(): Promise<{ ok: boolean; message: string }> {
  try {
    assertNotDemo();
    const { getCurrentAccountId, getAccountScopedSettings, resolveAgentModelConfig } = await import(
      "../../lib/workflow-runtime"
    );
    const accountId = await getCurrentAccountId();
    // Resolve EXACTLY as the worker does (account-scoped → env → 出厂免费预设回落).
    const cfg = await resolveAgentModelConfig(getAccountScopedSettings(accountId));
    const { createAgentModel, llmConfigError } = await import("@media-track/workflow");
    // BYO + agnostic: baseURL + 模型 are required; API Key is optional (keyless
    // local LLM). Surface the same actionable, model-agnostic message the agent uses.
    const configError = llmConfigError(cfg);
    if (configError) {
      return { ok: false, message: configError };
    }
    const { generateText } = await import("ai");
    const model = createAgentModel(cfg);
    // A tiny real call — proves the base_url/model (and key, if any) actually work,
    // killing the "stored a wrong value silently" 大误会.
    await generateText({ model, prompt: "ping" });
    return { ok: true, message: `连接正常 · ${cfg.modelId}` };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `连接失败：${msg.slice(0, 200)}` };
  }
}

export async function saveTmdbApiKeyAction(apiKey: string): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, getCurrentAccountId, TMDB_API_KEY_SETTING_KEY } = await import("../../lib/workflow-runtime");
    const repository = getWorkflowRepository();
    // Blank submit keeps the stored key (the form never echoes it back).
    const trimmed = apiKey.trim();
    if (trimmed) {
      await repository.setAccountSetting(await getCurrentAccountId(), TMDB_API_KEY_SETTING_KEY, trimmed);
    }
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

export async function clearTmdbApiKeyAction(): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, getCurrentAccountId, TMDB_API_KEY_SETTING_KEY } = await import("../../lib/workflow-runtime");
    await getWorkflowRepository().setAccountSetting(await getCurrentAccountId(), TMDB_API_KEY_SETTING_KEY, "");
    return { success: true };
  } catch (error) {
    return { success: false, message: `清除失败：${String(error)}` };
  }
}

export async function saveAssrtTokenAction(token: string): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, getCurrentAccountId, ASSRT_TOKEN_SETTING_KEY } = await import("../../lib/workflow-runtime");
    const repository = getWorkflowRepository();
    const trimmed = token.trim();
    if (trimmed) {
      await repository.setAccountSetting(await getCurrentAccountId(), ASSRT_TOKEN_SETTING_KEY, trimmed);
    }
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

export async function clearAssrtTokenAction(): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, getCurrentAccountId, ASSRT_TOKEN_SETTING_KEY } = await import("../../lib/workflow-runtime");
    await getWorkflowRepository().setAccountSetting(await getCurrentAccountId(), ASSRT_TOKEN_SETTING_KEY, "");
    return { success: true };
  } catch (error) {
    return { success: false, message: `清除失败：${String(error)}` };
  }
}

/** 自建搜索源的一份完整配置：地址 + 认证凭据（可选）。
 *  凭据只写库、密文落 account_settings（见 pansou-chain.ts 键上方注释）。 */
export interface PanSouConfigInput {
  username?: string;
  password?: string;
  /** 直接粘贴的 JWT。与用户名密码互斥，同时给定时以它为准。 */
  token?: string;
}

/** 归一化并校验后的凭据。auth 与三元组一起算出来，免得调用方再判一遍分支。 */
type ParsedPanSouCredentials =
  | { ok: false; message: string }
  | {
      ok: true;
      username: string;
      password: string;
      token: string;
      auth: PanSouAuth | undefined;
    };

/**
 * 把表单交上来的凭据收敛成一种形态。
 *
 * 抽成独立函数不只是为了降复杂度：这里集中了全部凭据规则（trim、互斥、优先级），
 * 保存入口是唯一的调用方，但规则必须能被单独读到、单独测。
 *
 * 「只配了一半」判失败 —— 一个没有密码的用户名发出去只会得到 401，而那会被报成
 * 「认证失败」，把用户引向「密码错了」这个错误结论。
 */
function parsePanSouCredentials(input: PanSouConfigInput): ParsedPanSouCredentials {
  const username = (input.username ?? "").trim();
  const password = input.password ?? "";
  const token = (input.token ?? "").trim();
  if ((username && !password) || (!username && password)) {
    return { ok: false, message: "用户名和密码需同时填写，未保存。" };
  }
  // token 优先：粘贴的令牌是用户明确指定「用这一个」，不该被一份可能已过期的
  // 旧密码覆盖。这是规格明确的互斥规则，表单上也这么提示。
  if (token) {
    return { ok: true, username, password, token, auth: { kind: "bearer", token } };
  }
  if (username && password) {
    return { ok: true, username, password, token, auth: { kind: "login", username, password } };
  }
  return { ok: true, username, password, token, auth: undefined };
}

export async function savePanSouConfigAction(
  baseURL: string,
  credentials: PanSouConfigInput = {},
): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const parsed = parsePanSouCredentials(credentials);
    if (!parsed.ok) {
      return { success: false, message: parsed.message };
    }
    const { getWorkflowRepository, getCurrentAccountId, PANSOU_BASE_URL_SETTING_KEY, PANSOU_HEALTH_SETTING_KEY } = await import("../../lib/workflow-runtime");
    const repository = getWorkflowRepository();
    const accountId = await getCurrentAccountId();
    const trimmed = baseURL.trim();
    // Empty = clear the override → falls back to env / public default.
    // 清空是正当操作,不必探活;顺手把上次的探活结论也清掉,否则设置页会对着一个
    // 已经不存在的自建源继续告警。凭据一并清掉：留着一段连不到的源对应的密码
    // 没有任何用处,只是多一份要轮换的秘密。
    if (!trimmed) {
      await repository.setAccountSetting(accountId, PANSOU_BASE_URL_SETTING_KEY, "");
      await repository.setAccountSetting(accountId, PANSOU_HEALTH_SETTING_KEY, "");
      await clearPanSouCredentials(accountId);
      return { success: true };
    }
    // 先做便宜的格式校验再花 8s 探活:少了它,一个漏写 scheme 的地址会拿到
    // 「连不上」这种含糊回复,而真正的问题是格式。agent API 侧本来就有这条校验,
    // 两个入口理应一致。
    const { probePanSou, validatePanSouBaseUrlFormat } = await import("../../lib/pansou-probe");
    const format = validatePanSouBaseUrlFormat(trimmed);
    if (!format.ok) {
      return { success: false, message: format.message };
    }
    // 存之前先真打一次。以前只校验 ^https?:// ,于是一个打不通的地址会被欣然
    // 保存,之后每次获取都静默失败并报成「未找到资源」——事故里这样活了 6 天。
    // 带认证探活：跳过登录就去打 /api/search，对一台开了认证的实例只会拿到 401，
    // 于是一条配对的配置被无解地拒绝。
    const probe = await probePanSou(trimmed, { auth: parsed.auth });
    if (!probe.ok) {
      return { success: false, message: probe.message };
    }
    await repository.setAccountSetting(accountId, PANSOU_BASE_URL_SETTING_KEY, trimmed);
    await repository.setAccountSetting(accountId, PANSOU_HEALTH_SETTING_KEY, "ok");
    await writePanSouCredentials(accountId, parsed);
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

/** 凭据落库。空值一律写成空串（删键），不写 null —— 仓库其余设置项都沿用
 *  空串表示「未配」，混用会让读取侧多一种要分辨的形态。 */
async function writePanSouCredentials(
  accountId: string,
  credentials: { username: string; password: string; token: string },
): Promise<void> {
  const { getWorkflowRepository } = await import("../../lib/workflow-runtime");
  const repository = getWorkflowRepository();
  const {
    PANSOU_USERNAME_SETTING_KEY,
    PANSOU_PASSWORD_SETTING_KEY,
    PANSOU_TOKEN_SETTING_KEY,
  } = await import("../../lib/pansou-chain");
  // encryptSecret 在 shared 里：AES-256-GCM + enc:v1: 信封，与网盘 cookie 同一把
  // 密钥、同一种格式。明文落库是不可接受的退化，所以加密失败就整体失败。
  const { encryptSecret } = await import("@media-track/shared");
  await repository.setAccountSetting(accountId, PANSOU_USERNAME_SETTING_KEY, credentials.username);
  await repository.setAccountSetting(
    accountId,
    PANSOU_PASSWORD_SETTING_KEY,
    credentials.password ? encryptSecret(credentials.password) : "",
  );
  await repository.setAccountSetting(
    accountId,
    PANSOU_TOKEN_SETTING_KEY,
    credentials.token ? encryptSecret(credentials.token) : "",
  );
}

async function clearPanSouCredentials(accountId: string): Promise<void> {
  await writePanSouCredentials(accountId, { username: "", password: "", token: "" });
}

export async function saveProwlarrConfigAction(input: {
  baseURL: string;
  apiKey: string;
}): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, getCurrentAccountId, PROWLARR_BASE_URL_SETTING_KEY, PROWLARR_API_KEY_SETTING_KEY } = await import(
      "../../lib/workflow-runtime"
    );
    const repository = getWorkflowRepository();
    const accountId = await getCurrentAccountId();
    await repository.setAccountSetting(accountId, PROWLARR_BASE_URL_SETTING_KEY, input.baseURL.trim());
    const apiKey = input.apiKey.trim();
    if (apiKey) {
      await repository.setAccountSetting(accountId, PROWLARR_API_KEY_SETTING_KEY, apiKey);
    }
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

export async function clearProwlarrConfigAction(): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, getCurrentAccountId, PROWLARR_BASE_URL_SETTING_KEY, PROWLARR_API_KEY_SETTING_KEY } = await import(
      "../../lib/workflow-runtime"
    );
    const repository = getWorkflowRepository();
    const accountId = await getCurrentAccountId();
    await repository.setAccountSetting(accountId, PROWLARR_BASE_URL_SETTING_KEY, "");
    await repository.setAccountSetting(accountId, PROWLARR_API_KEY_SETTING_KEY, "");
    return { success: true };
  } catch (error) {
    return { success: false, message: `清除失败：${String(error)}` };
  }
}

/** 海搜官方 API（idatariver 项目 b9d1）。保存前先真打一次搜索，把
 *  「key 无效 / 没余额」在保存这一刻就告诉用户 —— 否则它会一路静默成
 *  「这个源没结果」，用户永远查不到原因。 */
export async function saveHaisouConfigAction(input: {
  apiKey: string;
}): Promise<PushSettingsActionResult> {
  assertNotDemo();
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    return { success: false, message: "请填入 API Key" };
  }
  try {
    const { HaisouResourceProvider } = await import("@media-track/workflow");
    const probe = new HaisouResourceProvider({ apiKey });
    const snapshot = await probe.search({ keyword: "沙丘" });
    if (snapshot.sourceHealth && snapshot.sourceHealth.status !== "healthy") {
      return { success: false, message: "API Key 无效或额度不足（上游返回失败码）" };
    }
    const { getWorkflowRepository, getCurrentAccountId, HAISOU_API_KEY_SETTING_KEY } = await import(
      "../../lib/workflow-runtime"
    );
    await getWorkflowRepository().setAccountSetting(await getCurrentAccountId(), HAISOU_API_KEY_SETTING_KEY, apiKey);
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

export async function clearHaisouConfigAction(): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, getCurrentAccountId, HAISOU_API_KEY_SETTING_KEY } = await import(
      "../../lib/workflow-runtime"
    );
    await getWorkflowRepository().setAccountSetting(await getCurrentAccountId(), HAISOU_API_KEY_SETTING_KEY, "");
    return { success: true };
  } catch (error) {
    return { success: false, message: `清除失败：${String(error)}` };
  }
}

export async function saveJevConfigAction(input: {
  apiKey: string;
  baseUrl: string;
}): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const {
      getWorkflowRepository,
      getCurrentAccountId,
      getAccountScopedSettings,
      getJevConfig,
      getJevInheritedBaseUrl,
      JEV_API_KEY_SETTING_KEY,
      JEV_BASE_URL_SETTING_KEY,
      JEV_HEALTH_SETTING_KEY,
      JEV_PREFILTER_ENABLED_SETTING_KEY,
      JEV_PROBED_FOR_SETTING_KEY,
      jevConfigFingerprint,
      JEV_MODEL_SETTING_KEY,
    } = await import("../../lib/workflow-runtime");
    const { probeJev, validateJevBaseUrlFormat } = await import("../../lib/jev-probe");
    const repository = getWorkflowRepository();
    const accountId = await getCurrentAccountId();
    // 留空 = 沿用当前**生效**的配置(account → 全局 → env) —— 与表单上「已设置」
    // 占位符同一条规则。只读 account 行的话,一个存在于全局作用域或 env 的 key
    // 会在这里被判成「没有 key」;而 enabled/health 只有这个 action 会写,于是
    // 纯 env 部署永远激活不了。
    const scoped = getAccountScopedSettings(accountId, repository);
    const effective = await getJevConfig(scoped);
    const typedKey = input.apiKey.trim();
    const apiKey = typedKey || effective.apiKey || "";
    if (!apiKey) return { success: false, message: "需要 Jev API Key（OpenRouter 的 sk-or-… 或 TypeSafe 官方控制台的 Key 都可以）。" };
    const typedUrl = input.baseUrl.trim();
    // 自定义地址只配**本账号自己的** Key。key 可能继承自实例(全局行或 env):允许
    // 「只改地址」,等于让任一账号把共享 Key 发到它自己挑的服务器——探活发一次,之后
    // 每次搜索都发(多用户)。读取端(getJevConfig)对这种状态同样视为未测、零调用。
    const ownKey = typedKey || (await repository.getAccountSetting(accountId, JEV_API_KEY_SETTING_KEY))?.trim() || "";
    if (typedUrl && !ownKey) {
      return {
        success: false,
        message:
          "自定义 Base URL 需要同时填你自己的 Key：当前用的是实例共享的 Jev Key，它只会发往实例配置的地址。清空 Base URL，或填上你自己的 Key 再保存。未保存。",
      };
    }
    // 留空的 URL 会存成 ""(=去掉 account 覆盖),保存后真正生效的是 全局 → env → 默认。
    // 探活必须打**那个**地址:沿用 effective.baseUrl 会打到即将被清掉的旧覆盖,
    // 于是一个从没测过的端点被记成 healthy + enabled。
    const baseUrl = typedUrl || (await getJevInheritedBaseUrl(repository));
    // 先跑便宜的格式校验:漏写 scheme 的地址否则要耗满 8s 探活,再换回一句
    // 含糊的「连不上」,而真正的问题是格式(与 PanSou 同一条规则)。只校验用户这次
    // 输入的地址:继承来的(全局/env)是运营方的配置,不拿 http 规则去拦它。
    if (typedUrl) {
      const format = validateJevBaseUrlFormat(typedUrl);
      if (!format.ok) return { success: false, message: format.message };
    }
    // 存之前真打一次:一个打不通的 key 被保存后,预筛会在每次搜索上静默 fail-open,
    // 用户以为开了其实从没生效 —— 与 PanSou 自建源「活了 6 天」是同一种病。
    const probe = await probeJev({ apiKey, baseUrl });
    if (!probe.ok) return { success: false, message: probe.message };
    // 只写用户**这次真输入**的内容:留空的 key 不重写(全局/env 的 key 不会被
    // 复制进 account 行),留空的 URL 写 ""=无覆盖(同 Prowlarr),否则今天的默认
    // 端点会被冻进 DB,日后改 env JEV_BASE_URL 也推不动它。
    if (typedKey) await repository.setAccountSetting(accountId, JEV_API_KEY_SETTING_KEY, typedKey);
    await repository.setAccountSetting(accountId, JEV_BASE_URL_SETTING_KEY, typedUrl);
    await repository.setAccountSetting(accountId, JEV_HEALTH_SETTING_KEY, "ok");
    // 记下这次探活的是哪套 key/URL:之后 env 换了 key 或端点挪了,读取端就把 "ok"
    // 当成未测(见 getJevConfig),而不是顶着旧结论让每次搜索静默 fail-open。
    await repository.setAccountSetting(accountId, JEV_PROBED_FOR_SETTING_KEY, jevConfigFingerprint(apiKey, baseUrl));
    await repository.setAccountSetting(accountId, JEV_MODEL_SETTING_KEY, probe.model);
    await repository.setAccountSetting(accountId, JEV_PREFILTER_ENABLED_SETTING_KEY, "1");
    return { success: true, message: `已连通（${probe.model}）` };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

export async function clearJevConfigAction(): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const {
      getWorkflowRepository,
      getCurrentAccountId,
      JEV_API_KEY_SETTING_KEY,
      JEV_BASE_URL_SETTING_KEY,
      JEV_HEALTH_SETTING_KEY,
      JEV_PREFILTER_ENABLED_SETTING_KEY,
      JEV_PROBED_FOR_SETTING_KEY,
      JEV_MODEL_SETTING_KEY,
    } = await import("../../lib/workflow-runtime");
    const repository = getWorkflowRepository();
    const accountId = await getCurrentAccountId();
    for (const key of [JEV_API_KEY_SETTING_KEY, JEV_BASE_URL_SETTING_KEY, JEV_HEALTH_SETTING_KEY, JEV_PROBED_FOR_SETTING_KEY, JEV_MODEL_SETTING_KEY]) {
      await repository.setAccountSetting(accountId, key, "");
    }
    // A blank account row means "inherit" (account → global): blanking `enabled` too
    // would hand this account back to an instance-wide config that the worker keeps
    // using while the form says 未配置. 清除 means this account's prefilter is off.
    await repository.setAccountSetting(accountId, JEV_PREFILTER_ENABLED_SETTING_KEY, "0");
    return { success: true };
  } catch (error) {
    return { success: false, message: `清除失败：${String(error)}` };
  }
}

export async function setJevPrefilterEnabledAction(enabled: boolean): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, getCurrentAccountId, JEV_PREFILTER_ENABLED_SETTING_KEY } = await import(
      "../../lib/workflow-runtime"
    );
    const repository = getWorkflowRepository();
    const accountId = await getCurrentAccountId();
    await repository.setAccountSetting(accountId, JEV_PREFILTER_ENABLED_SETTING_KEY, enabled ? "1" : "0");
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

export async function testPushNotificationAction(
  settings: Record<string, string>,
): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { sendPushNotifications } = await import("@media-track/workflow");
    const { getAccountScopedSettings, getCurrentAccountId } = await import("../../lib/workflow-runtime");

    // Per-account: read THIS account's saved push config (account → global), and
    // send through the same scoped source so the test matches real delivery.
    const repository = getAccountScopedSettings(await getCurrentAccountId());
    const configFromDb: Record<string, string> = {};
    for (const key of ["bark", "serverchan", "wecom", "webhook"]) {
      const dbValue = await repository.getSetting(`push_${key}`);
      const formValue = settings[key]?.trim();
      configFromDb[key] = formValue || dbValue || "";
    }

    const sentTo = await sendPushNotifications({
      repository,
      notification: {
        id: "test_" + Date.now(),
        workflowRunId: "test",
        kind: "test",
        title: "📢 Media Track 测试通知",
        body: "如果你收到这条消息，说明推送渠道配置成功！",
        createdAt: new Date().toISOString(),
      },
      overrideConfig: configFromDb,
    });
    
    return { success: true, sentTo };
  } catch (error) {
    return { success: false, message: `测试失败：${String(error)}` };
  }
}
