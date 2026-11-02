import { Pan115OpenClient } from "@media-track/workflow";
import { getWorkflowRepository } from "../../../lib/workflow-runtime";
import { DEFAULT_ACCOUNT_ID } from "@media-track/contracts";
import type { Pan115OpenOAuthCredentials } from "@media-track/workflow";

const DEFAULT_LITEPAN_OAUTH_SERVER = "https://oauth.litepan.top";

function getOAuthServerUrl(): string {
  const envUrl = process.env.PAN115_OAUTH_SERVER_URL?.trim();
  return (envUrl || DEFAULT_LITEPAN_OAUTH_SERVER).replace(/\/$/, "");
}

export interface Pan115OAuthStartResult {
  ok: boolean;
  sessionId?: string;
  oauthUrl?: string;
  message?: string;
}

export interface Pan115OAuthPollResult {
  ok: boolean;
  status: "pending" | "success" | "error";
  accessToken?: string;
  refreshToken?: string;
  message?: string;
}

/**
 * 启动 115 开放平台 OAuth 授权流程 (复用 LitePan 公开中继机制)
 */
export async function startPan115OAuthRelay(): Promise<Pan115OAuthStartResult> {
  const base = getOAuthServerUrl();
  const url = `${base}/api/oauth/start`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "MediaryScout/1.0",
      },
      body: JSON.stringify({
        driver_type: "115_open",
        callback_url: `${base}/callback-popup`,
        server_use: true,
      }),
    });

    if (!res.ok) {
      return { ok: false, message: `OAuth 中继服务响应 HTTP ${res.status}` };
    }

    const json = (await res.json()) as any;
    if (!json?.success || !json?.data?.session_id) {
      return { ok: false, message: json?.message || "OAuth 中继服务未能生成授权链接" };
    }

    return {
      ok: true,
      sessionId: String(json.data.session_id),
      oauthUrl: String(json.data.oauth_url),
    };
  } catch (err) {
    return {
      ok: false,
      message: `连接 OAuth 中继服务失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function handleSuccessPoll(
  data: any,
  base: string,
  sessionId: string,
): Promise<Pan115OAuthPollResult> {
  const tokens = data?.token_data || {};
  const accessToken = String(tokens.access_token || "").trim();
  const refreshToken = String(tokens.refresh_token || "").trim();

  if (!accessToken || !refreshToken) {
    return { ok: false, status: "error", message: "OAuth 授权成功但未返回有效 Token" };
  }

  try {
    await fetch(`${base}/api/oauth/confirm-received/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "User-Agent": "MediaryScout/1.0" },
    });
  } catch {
    /* non-fatal */
  }

  return {
    ok: true,
    status: "success",
    accessToken,
    refreshToken,
  };
}

/**
 * 轮询 115 开放平台 OAuth 授权状态
 */
export async function pollPan115OAuthRelay(sessionId: string): Promise<Pan115OAuthPollResult> {
  const base = getOAuthServerUrl();
  const url = `${base}/api/oauth/status/${encodeURIComponent(sessionId)}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "MediaryScout/1.0",
      },
    });

    if (!res.ok) {
      return { ok: false, status: "error", message: `HTTP ${res.status}` };
    }

    const json = (await res.json()) as any;
    if (!json?.success) {
      return { ok: false, status: "error", message: json?.message || "查询 OAuth 状态失败" };
    }

    const data = json.data || {};
    const status = String(data.status || "pending");

    if (status === "success") {
      return await handleSuccessPoll(data, base, sessionId);
    }

    if (status === "error") {
      return {
        ok: false,
        status: "error",
        message: data.error || data.message || "授权已取消或失败",
      };
    }

    return { ok: true, status: "pending" };
  } catch (err) {
    return {
      ok: false,
      status: "error",
      message: `查询授权状态网络异常: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 校验并将 115 开放平台 OAuth 凭据绑定入库 (支持双轨融合升级)
 */
export async function connectPan115OpenOAuth(input: {
  accessToken: string;
  refreshToken: string;
  accountId: string;
}): Promise<{ ok: boolean; message: string; upgraded: boolean }> {
  const accessToken = input.accessToken.trim();
  const refreshToken = input.refreshToken.trim();

  if (!accessToken || !refreshToken) {
    throw new Error("访问令牌 (access_token) 与刷新令牌 (refresh_token) 均不能为空");
  }

  // 1. 测试 Token 连通性
  const openOAuth: Pan115OpenOAuthCredentials = {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + 7200 * 1000,
  };

  const client = new Pan115OpenClient({ credentials: openOAuth });
  try {
    await client.listItems({ directoryId: "0", limit: 1 });
  } catch (err) {
    throw new Error(`115 开放平台 Token 校验未通过: ${err instanceof Error ? err.message : String(err)}`);
  }

  const repository = getWorkflowRepository();
  const connectedStorages = await repository.listConnectedStorages(input.accountId);
  const existing115 = connectedStorages.find((s) => s.provider === "pan115");

  // 2. 若已有绑定的 115 账号，无缝升级为双轨驱动 (Dual-Engine)
  if (existing115) {
    const oldPayload = (existing115.payload || {}) as Record<string, unknown>;
    const newPayload = {
      ...oldPayload,
      openOAuth,
      engineMode: "dual_engine",
    };

    await repository.upsertConnectedStorage({
      id: existing115.id,
      accountId: existing115.accountId,
      provider: existing115.provider,
      providerUid: existing115.providerUid,
      label: existing115.label,
      payload: newPayload,
      rootCid: existing115.rootCid,
      moviesCid: existing115.moviesCid,
      tvCid: existing115.tvCid,
      animeCid: existing115.animeCid,
      createdAt: existing115.createdAt,
    });

    return {
      ok: true,
      message: "成功为现有 115 网盘升级开放平台 OAuth！已激活双轨融合极速驱动。",
      upgraded: true,
    };
  }

  // 3. 若尚未绑定 115 账号，作为独立开放平台驱动入库 (open_only 模式)
  const providerUid = `open_${Date.now()}`;
  const now = new Date().toISOString();
  await repository.upsertConnectedStorage({
    id: `cs_${providerUid}`,
    accountId: input.accountId || DEFAULT_ACCOUNT_ID,
    provider: "pan115",
    providerUid,
    label: "115开放平台",
    payload: {
      openOAuth,
      engineMode: "open_only",
      meta: { app: "115_open", connectedAt: now },
    },
    rootCid: null,
    moviesCid: null,
    tvCid: null,
    animeCid: null,
    createdAt: now,
  });

  return {
    ok: true,
    message: "成功添加 115 开放平台驱动！(提示: 后续补充扫码 Cookie 可激活分享转存能力)",
    upgraded: false,
  };
}
