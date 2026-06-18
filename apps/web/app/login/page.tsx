"use client";

import { useState, useTransition } from "react";
import { HelpCircle, LoaderCircle } from "lucide-react";

/**
 * §7 P1 login / register. Only reachable when MEDIA_TRACK_MULTI_USER=1 (single-
 * user deployments never see it — proxy passes through). Posts to the auth
 * routes, which set the signed httpOnly session cookie; on success we hard-nav to
 * the library so the new session is picked up server-side.
 */
export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        window.location.href = "/";
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "操作失败，请重试。");
    });
  };

  return (
    <main style={{ maxWidth: 360, margin: "14vh auto", padding: "0 20px" }}>
      <div className="panel" style={{ textAlign: "center" }}>
        <h1 className="panel-title" style={{ margin: "0 0 6px" }}>
          {mode === "login" ? "登录" : "创建账号"}
        </h1>
        <p className="panel-note" style={{ marginBottom: 20 }}>
          {mode === "login" ? "登录以访问你的媒体库" : "创建一个本地账号开始使用"}
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="setting-row" style={{ marginBottom: 10 }}>
            <input
              className="setting-control"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="用户名"
              aria-label="用户名"
              autoComplete="username"
            />
          </div>
          <div className="setting-row" style={{ marginBottom: 14 }}>
            <input
              type="password"
              className="setting-control"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="密码"
              aria-label="密码"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </div>
          {error ? (
            <p className="panel-note" style={{ color: "var(--danger, #e5484d)", marginBottom: 12 }}>
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            className="primary-button"
            disabled={isPending}
            style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            {isPending ? (
              <LoaderCircle size={14} className="spin" aria-hidden />
            ) : mode === "login" ? (
              "登录"
            ) : (
              "创建并登录"
            )}
          </button>
        </form>

        {mode === "register" ? (
          <div style={{ marginTop: 14 }}>
            <span
              role="note"
              tabIndex={0}
              onMouseEnter={() => setWhyOpen(true)}
              onMouseLeave={() => setWhyOpen(false)}
              onFocus={() => setWhyOpen(true)}
              onBlur={() => setWhyOpen(false)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 12,
                color: "var(--text-muted, #9a9a9a)",
                cursor: "help",
              }}
            >
              <HelpCircle size={13} aria-hidden />
              为什么我需要创建账号？
            </span>
            {whyOpen ? (
              <p
                className="panel-note"
                style={{
                  marginTop: 8,
                  textAlign: "left",
                  lineHeight: 1.7,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid var(--border, #2a2a2a)",
                  borderRadius: 8,
                  padding: "10px 12px",
                }}
              >
                账号不是「注册会员」，而是让<strong>同一个自部署实例容纳多个用户</strong>：每人各绑各自的
                115、各管各的媒体库、互不可见。默认一个实例只服务一个 115；多用户开启后，与家人或朋友合用
                一台实例、各连各的网盘即可，不再受「一实例只能用一个 115」的限制。
              </p>
            ) : null}
          </div>
        ) : null}

        <p className="panel-note" style={{ marginTop: 16 }}>
          {mode === "login" ? "还没有账号？" : "已有账号？"}{" "}
          <button
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError(null);
              setWhyOpen(false);
            }}
            style={{
              background: "none",
              border: "none",
              color: "var(--accent, #1db954)",
              cursor: "pointer",
              padding: 0,
              font: "inherit",
            }}
          >
            {mode === "login" ? "创建账号" : "去登录"}
          </button>
        </p>
      </div>
    </main>
  );
}
