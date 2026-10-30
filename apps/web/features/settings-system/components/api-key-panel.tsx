"use client";

import { useState, useTransition } from "react";
import { useRouter } from "../../../lib/use-router";
import { Check, Copy, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";

/**
 * S5.5 设置页 API Key 面板（客户端交互部分）。
 *
 * 三态由服务端读好传进来（db / env / none），与 /api/settings/api-key 的
 * GET 同一份 readApiKeyState——不在客户端再算一遍优先级。
 *
 * 两个写操作都打同一个端点（带 session cookie 的同源 fetch）：
 *   · 轮换 POST：完整 key **只在响应里出现一次**，组件把它放进本地 state
 *     展示 + 复制；router.refresh() 后服务端只剩掩码，刷新页面即消失。
 *   · 清除 DELETE：env 态在 UI 上就禁掉（后端也会 409 兜底）——页面清不掉
 *     部署期注入的值，禁按钮 + 说明好过让用户点了看报错。
 */

const ORIGIN_LABEL = {
  db: "来自数据库（本机设置，可轮换/清除）",
  env: "来自环境变量（部署期注入，页面不可清除）",
  none: "未配置",
} as const;

const ORIGIN_TONE = { db: "is-on", env: "is-warn", none: "" } as const;

export function ApiKeyPanel({
  initial,
}: {
  initial: { origin: "db" | "env" | "none"; masked: string | null; configured: boolean };
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const flash = (message: string) => {
    setResult(message);
    setTimeout(() => setResult(null), 5000);
  };

  const rotate = () => {
    startTransition(async () => {
      setFreshKey(null);
      setCopied(false);
      try {
        const res = await fetch("/api/settings/api-key", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        const body = (await res.json().catch(() => null)) as { apiKey?: string; error?: string } | null;
        if (!res.ok || !body?.apiKey) {
          flash(`❌ ${body?.error ?? "生成失败"}`);
          return;
        }
        setFreshKey(body.apiKey);
        flash("✅ 已生成新 key——现在复制走，离开此页就不再显示完整值。");
        router.refresh();
      } catch (error) {
        flash(`❌ ${String(error)}`);
      }
    });
  };

  const clear = () => {
    startTransition(async () => {
      try {
        const res = await fetch("/api/settings/api-key", { method: "DELETE" });
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) {
          flash(`❌ ${body?.error ?? "清除失败"}`);
          return;
        }
        setFreshKey(null);
        flash("✅ 已清除数据库里的 key。");
        router.refresh();
      } catch (error) {
        flash(`❌ ${String(error)}`);
      }
    });
  };

  const copy = () => {
    if (!freshKey) return;
    void navigator.clipboard
      .writeText(freshKey)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => flash("❌ 复制失败，请手动选中复制"));
  };

  return (
    <div className="push-form">
      <div className="setting-row">
        <code className="setting-control" style={{ fontFamily: "monospace" }}>
          {initial.masked ?? "未配置"}
        </code>
        <span className={`service-pill ${ORIGIN_TONE[initial.origin]}`}>{ORIGIN_LABEL[initial.origin]}</span>
        <button type="button" className="primary-button" onClick={rotate} disabled={isPending}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
          {initial.configured ? "轮换" : "生成"}
        </button>
        {initial.origin === "db" ? (
          <button type="button" className="secondary-button" onClick={clear} disabled={isPending}>
            <Trash2 size={14} aria-hidden />
            清除
          </button>
        ) : null}
      </div>

      {freshKey ? (
        <div className="setting-row" style={{ marginTop: 10 }}>
          <input
            className="setting-control"
            style={{ fontFamily: "monospace" }}
            readOnly
            value={freshKey}
            aria-label="新生成的 API Key（仅此一次）"
            onFocus={(event) => event.currentTarget.select()}
          />
          <button type="button" className="secondary-button" onClick={copy}>
            {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      ) : null}

      {initial.origin === "env" ? (
        <p className="panel-note" style={{ marginTop: 10 }}>
          当前生效的 key 由环境变量 <code>MEDIA_TRACK_API_KEY</code> 注入，页面无法清除；改部署配置后重启即可。
          在页面「轮换」会写一条数据库值并立即盖过它。
        </p>
      ) : null}

      {result ? (
        <p className="panel-note" style={{ marginTop: 10 }}>
          {result}
        </p>
      ) : null}
    </div>
  );
}
