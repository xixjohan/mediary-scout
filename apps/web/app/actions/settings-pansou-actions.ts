"use server";

import type { PanSouAuth } from "@media-track/workflow";
import { assertNotDemo } from "../../lib/demo-mode";
import type { PushSettingsActionResult } from "./settings-system-actions";
import type { PanSouConfigInput, PanSouConfigSaveMode } from "../../features/settings-system/contracts/pansou-config";

interface ParsedPanSouCredentials {
  ok: true;
  username: string;
  password: string;
  token: string;
  auth: PanSouAuth | undefined;
}

interface PanSouAccountSettingsRepository {
  getAccountSetting(accountId: string, key: string): Promise<string | null>;
  setAccountSetting(accountId: string, key: string, value: string): Promise<void>;
}

function parsePanSouCredentials(input: PanSouConfigInput): ParsedPanSouCredentials | { ok: false; message: string } {
  const username = (input.username ?? "").trim();
  const password = input.password ?? "";
  const token = (input.token ?? "").trim();
  if ((username && !password) || (!username && password)) {
    return { ok: false, message: "用户名和密码需同时填写，未保存。" };
  }
  if (token) return { ok: true, username, password, token, auth: { kind: "bearer", token } };
  if (username && password) return { ok: true, username, password, token, auth: { kind: "login", username, password } };
  return { ok: true, username, password, token, auth: undefined };
}

export async function savePanSouConfigAction(
  baseURL: string,
  credentials: PanSouConfigInput = {},
  mode: PanSouConfigSaveMode = "override",
): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const {
      getWorkflowRepository,
      getCurrentAccountId,
      PANSOU_BASE_URL_SETTING_KEY,
      PANSOU_HEALTH_SETTING_KEY,
    } = await import("../../lib/workflow-runtime");
    const repository = getWorkflowRepository();
    const accountId = await getCurrentAccountId();
    if (mode === "clear") {
      await clearPanSouConfig(repository, accountId, PANSOU_BASE_URL_SETTING_KEY, PANSOU_HEALTH_SETTING_KEY);
      return { success: true };
    }

    const target = await resolvePanSouSaveTarget(repository, accountId, baseURL, mode, PANSOU_BASE_URL_SETTING_KEY);
    if (!target.ok) return { success: false, message: target.message };
    const input = await resolveEffectivePanSouCredentials(repository, accountId, credentials, mode);
    const parsed = parsePanSouCredentials(input);
    if (!parsed.ok) return { success: false, message: parsed.message };

    const { probePanSou, validatePanSouBaseUrlFormat } = await import("../../lib/pansou-probe");
    const format = validatePanSouBaseUrlFormat(target.baseURL);
    if (!format.ok) return { success: false, message: format.message };
    const probe = await probePanSou(target.baseURL, { auth: parsed.auth });
    if (!probe.ok) return { success: false, message: probe.message };

    if (target.persistOverride) {
      await repository.setAccountSetting(accountId, PANSOU_BASE_URL_SETTING_KEY, target.baseURL);
    }
    await repository.setAccountSetting(accountId, PANSOU_HEALTH_SETTING_KEY, "ok");
    await writePanSouCredentials(repository, accountId, parsed);
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

async function clearPanSouConfig(
  repository: PanSouAccountSettingsRepository,
  accountId: string,
  baseURLSettingKey: string,
  healthSettingKey: string,
): Promise<void> {
  await repository.setAccountSetting(accountId, baseURLSettingKey, "");
  await repository.setAccountSetting(accountId, healthSettingKey, "");
  await writePanSouCredentials(repository, accountId, { username: "", password: "", token: "" });
}

async function resolvePanSouSaveTarget(
  repository: PanSouAccountSettingsRepository,
  accountId: string,
  baseURL: string,
  mode: Exclude<PanSouConfigSaveMode, "clear">,
  baseURLSettingKey: string,
): Promise<{ ok: true; baseURL: string; persistOverride: boolean } | { ok: false; message: string }> {
  if (mode === "override") {
    const trimmed = baseURL.trim();
    return trimmed
      ? { ok: true, baseURL: trimmed, persistOverride: true }
      : { ok: false, message: "请先填写 PanSou 地址；清除地址覆盖请使用单独的恢复按钮。" };
  }
  const { resolveUserPanSouBaseUrl, DEFAULT_PANSOU_BASE_URL } = await import("../../lib/pansou-chain");
  const dbBaseURL = await repository.getAccountSetting(accountId, baseURLSettingKey);
  return {
    ok: true,
    baseURL: resolveUserPanSouBaseUrl(dbBaseURL, process.env) || DEFAULT_PANSOU_BASE_URL,
    persistOverride: false,
  };
}

async function resolveEffectivePanSouCredentials(
  repository: PanSouAccountSettingsRepository,
  accountId: string,
  credentials: PanSouConfigInput,
  mode: Exclude<PanSouConfigSaveMode, "clear">,
): Promise<PanSouConfigInput> {
  const effective = { ...credentials };
  const { PANSOU_USERNAME_SETTING_KEY, PANSOU_PASSWORD_SETTING_KEY, PANSOU_TOKEN_SETTING_KEY } = await import(
    "../../lib/pansou-chain"
  );
  if (mode === "credentials" && !credentials.password && !credentials.token) {
    let passwordRestored = false;
    if (credentials.username) {
      const existingUser = await repository.getAccountSetting(accountId, PANSOU_USERNAME_SETTING_KEY);
      const encryptedPassword = await repository.getAccountSetting(accountId, PANSOU_PASSWORD_SETTING_KEY);
      if (existingUser === credentials.username.trim() && encryptedPassword) {
        effective.password = await decryptPanSouSecret(encryptedPassword);
        passwordRestored = Boolean(effective.password);
      }
    }
    if (!passwordRestored) {
      const encryptedToken = await repository.getAccountSetting(accountId, PANSOU_TOKEN_SETTING_KEY);
      if (encryptedToken) effective.token = await decryptPanSouSecret(encryptedToken);
    }
  }
  return effective;
}

async function decryptPanSouSecret(encrypted: string): Promise<string> {
  try {
    const { decryptSecret } = await import("@media-track/shared");
    return decryptSecret(encrypted).trim();
  } catch {
    return "";
  }
}

async function writePanSouCredentials(
  repository: PanSouAccountSettingsRepository,
  accountId: string,
  credentials: { username: string; password: string; token: string },
): Promise<void> {
  const {
    PANSOU_USERNAME_SETTING_KEY,
    PANSOU_PASSWORD_SETTING_KEY,
    PANSOU_TOKEN_SETTING_KEY,
  } = await import("../../lib/pansou-chain");
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
