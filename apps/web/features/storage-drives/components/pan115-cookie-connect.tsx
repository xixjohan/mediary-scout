"use client";

import { useState, useTransition } from "react";
import { Check, ExternalLink, LoaderCircle } from "lucide-react";
import { useRouter } from "../../../lib/use-router";
import { connectPan115CookieAction } from "../../../app/actions";
import { runAction } from "../../../lib/run-action";

/**
 * 手动 115 Cookie 连接 —— 扫码登录的折叠回退。
 * 用户从 115 网页端或抓包工具复制包含 UID、CID、SEID 的 Cookie 粘贴进来。
 */
export function Pan115CookieConnect() {
  const router = useRouter();
  const [cookie, setCookie] = useState("");
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  const handleConnect = () => {
    startTransition(async () => {
      const r = await runAction(
        () => connectPan115CookieAction(cookie),
        (msg) => setResult(`❌ ${msg}`),
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.ok ? `✅ ${res.message}` : `❌ ${res.message}`);
      if (res.ok) {
        setCookie("");
        router.refresh();
      }
    });
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: "var(--mt-space-1, 6px)" }}>
        扫码登录失败时的手动回退：打开 <code>115.com</code> 登录后，在浏览器开发者工具（F12）的 Network
        里点任意请求，复制请求头里的完整 Cookie（需包含 <code>UID</code>、<code>CID</code>、<code>SEID</code>），粘贴到下方输入框。
      </p>
      <p className="push-help" style={{ marginBottom: "var(--mt-space-2, 12px)" }}>
        115网盘{" "}
        <a href="https://115.com/" target="_blank" rel="noopener noreferrer">
          官网 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
        </a>
      </p>
      <textarea
        className="setting-textarea"
        value={cookie}
        onChange={(event) => setCookie(event.target.value)}
        placeholder="把完整的 115 Cookie 粘到这里（形如 UID=…; CID=…; SEID=…）"
        aria-label="115网盘 Cookie"
        rows={4}
        style={{ width: "100%", fontFamily: "monospace", fontSize: 12, resize: "vertical" }}
      />
      <div className="setting-row" style={{ marginTop: "var(--mt-space-2, 10px)" }}>
        <button
          type="button"
          className="primary-button"
          onClick={handleConnect}
          disabled={isPending || !cookie.trim()}
        >
          {isPending ? (
            <LoaderCircle size={14} className="spin" aria-hidden />
          ) : (
            <Check size={14} aria-hidden />
          )}
          连接115网盘
        </button>
      </div>
      {result ? (
        <p className="panel-note" style={{ marginTop: "var(--mt-space-2, 10px)" }}>
          {result}
        </p>
      ) : null}
    </div>
  );
}
