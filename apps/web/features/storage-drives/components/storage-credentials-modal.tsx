"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Lock, Copy, Check, X, AlertTriangle, ShieldAlert, KeyRound, LoaderCircle } from "lucide-react";
import { checkAccountHasPasswordAction, revealStorageCredentialAction } from "../../../app/actions/storage-drives-actions";
import type { RevealedCredentials } from "@media-track/workflow";

interface StorageCredentialsModalProps {
  storageId: string;
  providerLabel: string;
  onClose: () => void;
}

interface ChallengeFormProps {
  hasPassword: boolean;
  password: string;
  submitting: boolean;
  error: string | null;
  onPasswordChange: (val: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onClose: () => void;
}

function CredentialChallengeForm({
  hasPassword,
  password,
  submitting,
  error,
  onPasswordChange,
  onSubmit,
  onClose,
}: ChallengeFormProps) {
  return (
    <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{
          padding: 14,
          background: "rgba(245, 158, 11, 0.08)",
          border: "1px solid rgba(245, 158, 11, 0.2)",
          borderRadius: 8,
          fontSize: 13,
          color: "#fcd34d",
          lineHeight: 1.6,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, marginBottom: 4 }}>
          <ShieldAlert size={16} />
          零信任安全凭据保护规范
        </div>
        <div>
          网盘 Cookie（含 SEID 会话）与 OAuth 密钥具有完全接管网盘的最高权限。
          查阅明文仅在前端内存保留 <strong>30 秒</strong>，倒计时结束后自动遮蔽清空。请确认周围环境安全无窥视。
        </div>
      </div>

      {hasPassword ? (
        <div>
          <label style={{ display: "block", fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
            请输入当前账户登录密码进行二次验证：
          </label>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            placeholder="请输入账户登录密码"
            className="setting-input"
            style={{ width: "100%" }}
          />
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "#a1a1aa" }}>
          💡 当前系统运行于单用户免密环境。点击下方按钮确认后即刻解密查看。
        </div>
      )}

      {error ? (
        <div style={{ color: "#ef4444", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
          <AlertTriangle size={14} />
          {error}
        </div>
      ) : null}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
        <button type="button" className="secondary-button" onClick={onClose}>
          取消
        </button>
        <button type="submit" className="primary-button" disabled={submitting}>
          {submitting ? "解密中…" : hasPassword ? "验证并查看明文" : "我已知晓风险，确认查看"}
        </button>
      </div>
    </form>
  );
}

interface RevealedViewProps {
  revealed: RevealedCredentials;
  timeLeft: number;
  copiedKey: string | null;
  onCopy: (key: string, text: string) => void;
  onMaskNow: () => void;
}

function RevealedCredentialsView({
  revealed,
  timeLeft,
  copiedKey,
  onCopy,
  onMaskNow,
}: RevealedViewProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Ephemeral Countdown Banner */}
      <div
        style={{
          padding: "10px 14px",
          background: "rgba(16, 185, 129, 0.1)",
          border: "1px solid rgba(16, 185, 129, 0.25)",
          borderRadius: 6,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#10b981", fontWeight: 500 }}>
          <Lock size={15} />
          <span>凭据已临时解密曝光（倒计时 <strong>{timeLeft}</strong> 秒后自动遮蔽销毁）</span>
        </div>
        <div
          style={{
            width: 70,
            height: 6,
            background: "rgba(255, 255, 255, 0.1)",
            borderRadius: 3,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${(timeLeft / 30) * 100}%`,
              background: timeLeft > 10 ? "#10b981" : "#ef4444",
              transition: "width 1s linear",
            }}
          />
        </div>
      </div>

      {revealed.cookie ? (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "#e4e4e7" }}>网盘 Cookie 凭据 (全量明文):</label>
            <button
              type="button"
              className="ghost-button"
              onClick={() => onCopy("cookie", revealed.cookie!)}
              style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4, color: "#10b981" }}
            >
              {copiedKey === "cookie" ? <Check size={13} /> : <Copy size={13} />}
              {copiedKey === "cookie" ? "已复制" : "一键复制 Cookie"}
            </button>
          </div>
          <textarea
            readOnly
            rows={4}
            value={revealed.cookie}
            style={{
              width: "100%",
              background: "#09090b",
              border: "1px solid rgba(255, 255, 255, 0.15)",
              borderRadius: 6,
              padding: 10,
              fontSize: 12,
              fontFamily: "monospace",
              color: "#a1a1aa",
              resize: "none",
            }}
          />
        </div>
      ) : null}

      {revealed.openOAuth ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: "#e4e4e7" }}>OAuth Access Token:</label>
              <button
                type="button"
                className="ghost-button"
                onClick={() => onCopy("accessToken", revealed.openOAuth!.accessToken)}
                style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4, color: "#10b981" }}
              >
                {copiedKey === "accessToken" ? <Check size={13} /> : <Copy size={13} />}
                {copiedKey === "accessToken" ? "已复制" : "复制 Access Token"}
              </button>
            </div>
            <input
              type="text"
              readOnly
              value={revealed.openOAuth.accessToken}
              className="setting-input"
              style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
            />
          </div>

          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: "#e4e4e7" }}>OAuth Refresh Token:</label>
              <button
                type="button"
                className="ghost-button"
                onClick={() => onCopy("refreshToken", revealed.openOAuth!.refreshToken)}
                style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4, color: "#10b981" }}
              >
                {copiedKey === "refreshToken" ? <Check size={13} /> : <Copy size={13} />}
                {copiedKey === "refreshToken" ? "已复制" : "复制 Refresh Token"}
              </button>
            </div>
            <input
              type="text"
              readOnly
              value={revealed.openOAuth.refreshToken}
              className="setting-input"
              style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
            />
          </div>
        </div>
      ) : null}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
        <button
          type="button"
          className="secondary-button"
          onClick={onMaskNow}
        >
          立即隐藏并遮蔽
        </button>
      </div>
    </div>
  );
}

export function StorageCredentialsModal({
  storageId,
  providerLabel,
  onClose,
}: StorageCredentialsModalProps) {
  const [checkingPassword, setCheckingPassword] = useState(true);
  const [hasPassword, setHasPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [revealed, setRevealed] = useState<RevealedCredentials | null>(null);
  const [timeLeft, setTimeLeft] = useState(30);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const has = await checkAccountHasPasswordAction();
        if (!cancelled) {
          setHasPassword(has);
          setCheckingPassword(false);
        }
      } catch {
        if (!cancelled) {
          setHasPassword(false);
          setCheckingPassword(false);
        }
      }
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!revealed) return;
    setTimeLeft(30);
    const interval = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          setRevealed(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [revealed]);

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await revealStorageCredentialAction(storageId, hasPassword ? password : undefined);
      if (!res.ok || !res.credentials) {
        setError(res.error || "验证失败，无法获取凭据");
      } else {
        setRevealed(res.credentials);
        setPassword("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyToClipboard(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      setError("复制到剪贴板失败，请手动全选复制");
    }
  }

  if (!mounted) return null;

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.75)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: 16,
      }}
    >
      <div
        className="panel"
        style={{
          width: "100%",
          maxWidth: 600,
          background: "#18181b",
          border: "1px solid rgba(255, 255, 255, 0.12)",
          borderRadius: 12,
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.6)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <KeyRound size={18} style={{ color: "#f59e0b" }} />
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              {providerLabel} · 网盘敏感凭据安全查阅
            </h3>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={onClose}
            style={{ padding: 4, borderRadius: 6 }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: 20 }}>
          {checkingPassword ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "30px 0", gap: 12 }}>
              <LoaderCircle size={24} className="spin" style={{ color: "#10b981" }} />
              <p style={{ margin: 0, color: "#a1a1aa", fontSize: 13 }}>正在校验安全环境…</p>
            </div>
          ) : !revealed ? (
            <CredentialChallengeForm
              hasPassword={hasPassword}
              password={password}
              submitting={submitting}
              error={error}
              onPasswordChange={setPassword}
              onSubmit={handleUnlock}
              onClose={onClose}
            />
          ) : (
            <RevealedCredentialsView
              revealed={revealed}
              timeLeft={timeLeft}
              copiedKey={copiedKey}
              onCopy={copyToClipboard}
              onMaskNow={() => setRevealed(null)}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
