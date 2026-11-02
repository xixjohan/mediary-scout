"use client";

import { useState, useRef, useEffect, useTransition } from "react";
import { Check, ExternalLink, LoaderCircle, Sparkles, KeyRound, RefreshCw, XCircle } from "lucide-react";
import { useRouter } from "../../../lib/use-router";
import {
  startPan115OAuthAction,
  pollPan115OAuthAction,
  connectPan115OpenOAuthAction,
} from "../../../app/actions/storage-drives-actions";
import { runAction } from "../../../lib/run-action";

export function Pan115OpenConnect() {
  const router = useRouter();
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const isPollingRef = useRef(false);
  const popupRef = useRef<Window | null>(null);

  useEffect(() => {
    return () => {
      isPollingRef.current = false;
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
    };
  }, []);

  // 1. 提交连接
  const handleConnect = (overrideAccess?: string, overrideRefresh?: string) => {
    const acc = overrideAccess ?? accessToken;
    const ref = overrideRefresh ?? refreshToken;

    if (!acc.trim() || !ref.trim()) {
      setStatusMessage("❌ 请完整输入 access_token 与 refresh_token");
      return;
    }

    startTransition(async () => {
      setStatusMessage("正在校验 Token 连通性并激活双轨驱动...");
      const r = await runAction(
        () => connectPan115OpenOAuthAction({ accessToken: acc.trim(), refreshToken: ref.trim() }),
        (msg) => setStatusMessage(`❌ ${msg}`),
      );
      if (!r.ok) return;
      const res = r.value;
      setStatusMessage(res.ok ? `✅ ${res.message}` : `❌ ${res.message}`);
      if (res.ok) {
        setAccessToken("");
        setRefreshToken("");
        router.refresh();
      }
    });
  };

  // 2. 一键通过中继启动 OAuth (LitePan 机制)
  const handleStartOAuth = async () => {
    setIsAuthorizing(true);
    setStatusMessage("正在启动 115 开放平台授权通道...");

    try {
      const res = await startPan115OAuthAction();
      if (!res.ok || !res.sessionId || !res.oauthUrl) {
        setIsAuthorizing(false);
        setStatusMessage(`❌ ${res.message || "未能启动授权"}`);
        return;
      }

      // 打开授权弹窗
      const w = 520;
      const h = 640;
      const left = window.screenX + (window.outerWidth - w) / 2;
      const top = window.screenY + (window.outerHeight - h) / 2;
      const popup = window.open(
        res.oauthUrl,
        "115_oauth_window",
        `width=${w},height=${h},left=${left},top=${top},status=no,resizable=yes`,
      );
      popupRef.current = popup;

      isPollingRef.current = true;
      setStatusMessage("请在弹出的 115 开放平台窗口中完成扫码或授权...");

      // 启动轮询
      const sessionId = res.sessionId;
      const startTime = Date.now();
      const maxDuration = 300 * 1000; // 5分钟

      const poll = async () => {
        if (!isPollingRef.current) return;
        if (Date.now() - startTime > maxDuration) {
          setIsAuthorizing(false);
          setStatusMessage("❌ 授权超时，请重试");
          return;
        }

        const pollRes = await pollPan115OAuthAction(sessionId);
        if (!isPollingRef.current) return;

        if (pollRes.status === "success" && pollRes.accessToken && pollRes.refreshToken) {
          setIsAuthorizing(false);
          isPollingRef.current = false;
          if (popup && !popup.closed) {
            popup.close();
          }
          setAccessToken(pollRes.accessToken);
          setRefreshToken(pollRes.refreshToken);
          setStatusMessage("🎉 授权成功！正在自动提交凭据并激活双轨模式...");
          // 自动提交绑定
          handleConnect(pollRes.accessToken, pollRes.refreshToken);
          return;
        }

        if (pollRes.status === "error") {
          setIsAuthorizing(false);
          isPollingRef.current = false;
          setStatusMessage(`❌ 授权失败: ${pollRes.message || "用户取消授权"}`);
          return;
        }

        // 继续等待轮询
        setTimeout(() => {
          void poll();
        }, 2500);
      };

      setTimeout(() => {
        void poll();
      }, 2000);
    } catch (err) {
      setIsAuthorizing(false);
      setStatusMessage(`❌ 启动授权异常: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleCancelOAuth = () => {
    isPollingRef.current = false;
    setIsAuthorizing(false);
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.close();
    }
    setStatusMessage("已取消授权");
  };

  return (
    <div className="push-form" style={{ background: "rgba(16, 185, 129, 0.05)", border: "1px solid rgba(16, 185, 129, 0.2)", borderRadius: 8, padding: 16 }}>
      {/* 头部特性与说明 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Sparkles size={16} color="#10b981" />
          <strong style={{ fontSize: 13, color: "#10b981" }}>115 开放平台 OAuth 双轨增强</strong>
        </div>
        <span style={{ fontSize: 11, background: "rgba(16, 185, 129, 0.15)", color: "#10b981", padding: "2px 8px", borderRadius: 12 }}>
          永久免掉线 · 10倍速扫库
        </span>
      </div>

      <p className="panel-note" style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 14 }}>
        通过 115 官方开放平台 OAuth 授权（对标 LitePan），可将媒体库大清单拉取与播放直链无缝卸载至开放平台通道，
        享有 <code>refresh_token</code> 静默自动续期；原分享转存继续走 Cookie，两者无感融合。
      </p>

      {/* 一键快捷授权按钮 (LitePan 方案) */}
      <div style={{ marginBottom: 16, display: "flex", gap: 10, alignItems: "center" }}>
        {isAuthorizing ? (
          <>
            <button type="button" className="primary-button" disabled style={{ opacity: 0.85 }}>
              <LoaderCircle size={14} className="spin" aria-hidden />
              正在等待 115 授权确认...
            </button>
            <button type="button" className="secondary-button" onClick={handleCancelOAuth}>
              <XCircle size={14} aria-hidden />
              取消
            </button>
          </>
        ) : (
          <button
            type="button"
            className="primary-button"
            onClick={handleStartOAuth}
            style={{ background: "#10b981", borderColor: "#10b981" }}
          >
            <ExternalLink size={14} aria-hidden />
            一键通过 115 开放平台授权 (LitePan 机制)
          </button>
        )}
      </div>

      {/* 手动填报区域 */}
      <details style={{ marginTop: 10 }}>
        <summary className="panel-note" style={{ cursor: "pointer", fontSize: 12 }}>
          已有 Token？点击手动填报 access_token 与 refresh_token
        </summary>
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <label style={{ fontSize: 12, display: "block", marginBottom: 4, color: "var(--color-text-muted, #888)" }}>
              访问令牌 (access_token):
            </label>
            <input
              type="password"
              className="setting-input"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder="eyJhbGciOi..."
              style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
            />
          </div>

          <div>
            <label style={{ fontSize: 12, display: "block", marginBottom: 4, color: "var(--color-text-muted, #888)" }}>
              刷新令牌 (refresh_token):
            </label>
            <input
              type="password"
              className="setting-input"
              value={refreshToken}
              onChange={(e) => setRefreshToken(e.target.value)}
              placeholder="rt_..."
              style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
            />
          </div>

          <div style={{ marginTop: 6 }}>
            <button
              type="button"
              className="primary-button"
              onClick={() => handleConnect()}
              disabled={isPending || !accessToken.trim() || !refreshToken.trim()}
            >
              {isPending ? (
                <LoaderCircle size={14} className="spin" aria-hidden />
              ) : (
                <KeyRound size={14} aria-hidden />
              )}
              手动保存并激活双轨模式
            </button>
          </div>
        </div>
      </details>

      {/* 状态与执行提示 */}
      {statusMessage ? (
        <p className="panel-note" style={{ marginTop: 12, fontSize: 12, fontWeight: 500 }}>
          {statusMessage}
        </p>
      ) : null}
    </div>
  );
}
