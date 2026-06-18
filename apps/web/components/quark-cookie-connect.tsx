"use client";

import { useState, useTransition } from "react";
import { Check, ExternalLink, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { connectQuarkAction } from "../app/actions";

/**
 * 夸克 connect = paste the cookie. 夸克 QR-login is not cleanly automatable and the
 * browser-automation skill forbids auto-reading cookies, so the user copies the
 * Cookie header from a夸克 web request (Copy as cURL) — honest v1 fallback.
 */
export function QuarkCookieConnect() {
  const router = useRouter();
  const [cookie, setCookie] = useState("");
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  const handleConnect = () => {
    startTransition(async () => {
      const res = await connectQuarkAction(cookie);
      setResult(res.ok ? `✅ ${res.message}` : `❌ ${res.message}`);
      if (res.ok) {
        setCookie("");
        router.refresh();
      }
    });
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: 6 }}>
        夸克暂用 cookie 连接（不支持扫码自动化）。打开 <code>pan.quark.cn</code> 登录后，在浏览器开发者工具
        Network 里随便点一个 <code>drive-pc.quark.cn</code> 请求 → 复制其请求头里的完整 Cookie（需包含
        <code> __pus</code> / <code>__uid</code>），粘贴到下面。
      </p>
      <p className="push-help" style={{ marginBottom: 12 }}>
        夸克网盘{" "}
        <a href="https://pan.quark.cn/" target="_blank" rel="noopener noreferrer">
          官网 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
        </a>
      </p>
      <textarea
        className="setting-control"
        value={cookie}
        onChange={(event) => setCookie(event.target.value)}
        placeholder="__pus=...; __uid=...; __kps=...; ..."
        aria-label="夸克 Cookie"
        rows={4}
        style={{ width: "100%", fontFamily: "monospace", fontSize: 12, resize: "vertical" }}
      />
      <div className="setting-row" style={{ marginTop: 10 }}>
        <button type="button" className="primary-button" onClick={handleConnect} disabled={isPending || !cookie.trim()}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          连接夸克
        </button>
      </div>
      {result ? (
        <p className="panel-note" style={{ marginTop: 10 }}>
          {result}
        </p>
      ) : null}
    </div>
  );
}
