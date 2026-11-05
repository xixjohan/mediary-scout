"use client";

import { useState, useTransition } from "react";
import { Activity, Check, LoaderCircle, Trash2 } from "lucide-react";
import {
  saveProxyConfigAction,
  testProxyConnectionAction,
  type ProxyConfigInput,
} from "../../../app/actions/settings-runtime-governance-actions";
import { runAction } from "../../../lib/run-action";

export function ProxyConfigForm({ initial }: { initial: ProxyConfigInput }) {
  const [isPending, startTransition] = useTransition();
  const [isTesting, setIsTesting] = useState(false);
  const [httpProxy, setHttpProxy] = useState(initial.httpProxy || "");
  const [httpsProxy, setHttpsProxy] = useState(initial.httpsProxy || "");
  const [noProxy, setNoProxy] = useState(initial.noProxy || "");
  const [result, setResult] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const handleSave = () => {
    startTransition(async () => {
      const r = await runAction(
        () =>
          saveProxyConfigAction({
            httpProxy,
            httpsProxy,
            noProxy,
          }),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 3500);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      if (res.success) {
        setResult(
          res.enabled
            ? `✅ 代理已热重载生效 (${res.proxyDisplay ?? "已启用"})`
            : "✅ 代理已关闭，恢复直连模式",
        );
      } else {
        setResult(`❌ ${res.message}`);
      }
      setTimeout(() => setResult(null), 3500);
    });
  };

  const handleClear = () => {
    setHttpProxy("");
    setHttpsProxy("");
    startTransition(async () => {
      const r = await runAction(
        () =>
          saveProxyConfigAction({
            httpProxy: "",
            httpsProxy: "",
            noProxy,
          }),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 3500);
        },
      );
      if (!r.ok) return;
      setResult("✅ 代理已清除，恢复直连模式");
      setTimeout(() => setResult(null), 3500);
    });
  };

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await testProxyConnectionAction();
      if (res.ok) {
        setTestResult(`🟢 TMDB API 连通正常 (${res.latencyMs}ms)`);
      } else {
        setTestResult(`🔴 无法连接 TMDB: ${res.message}`);
      }
    } catch (e) {
      setTestResult(`🔴 测试发生异常: ${String(e)}`);
    } finally {
      setIsTesting(false);
      setTimeout(() => setTestResult(null), 5000);
    }
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: 12 }}>
        配置服务端出站网络代理（科学上网），用于服务器直连 TMDB 官方元数据或 GitHub 更新。系统内置国内网盘（115、夸克、UC、123、天翼）及局域网直连白名单，国内服务绝不误走代理。
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        <div>
          <label className="text-xs font-medium text-muted block" style={{ marginBottom: 4 }}>
            HTTP 代理地址
          </label>
          <input
            type="text"
            className="setting-control w-full"
            placeholder="http://127.0.0.1:7890"
            value={httpProxy}
            onChange={(e) => setHttpProxy(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted block" style={{ marginBottom: 4 }}>
            HTTPS 代理地址 (可选，留空同 HTTP)
          </label>
          <input
            type="text"
            className="setting-control w-full"
            placeholder="http://127.0.0.1:7890"
            value={httpsProxy}
            onChange={(e) => setHttpsProxy(e.target.value)}
          />
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <label className="text-xs font-medium text-muted block" style={{ marginBottom: 4 }}>
            自定义免代理白名单 NO_PROXY（逗号分隔，可选）
        </label>
        <input
          type="text"
          className="setting-control w-full"
          placeholder="localhost,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
          value={noProxy}
          onChange={(e) => setNoProxy(e.target.value)}
        />
        <p className="panel-note" style={{ marginTop: 5 }}>
          支持主机名、域名后缀和 IPv4 / IPv6 CIDR（如 10.0.0.0/8）；CIDR 只匹配 URL 中的 IP 字面量，不会解析域名。
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          className="primary-button"
          onClick={handleSave}
          disabled={isPending || isTesting}
        >
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存并热生效
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={handleTest}
          disabled={isPending || isTesting}
        >
          {isTesting ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Activity size={14} aria-hidden />}
          测试代理连通性
        </button>
        {(httpProxy || httpsProxy) ? (
          <button
            type="button"
            className="secondary-button text-danger"
            onClick={handleClear}
            disabled={isPending || isTesting}
          >
            <Trash2 size={14} aria-hidden />
            清空代理
          </button>
        ) : null}
      </div>

      {result ? (
        <p className="panel-note" style={{ marginTop: 10 }}>
          {result}
        </p>
      ) : null}

      {testResult ? (
        <p className="panel-note font-medium" style={{ marginTop: 10 }}>
          {testResult}
        </p>
      ) : null}
    </div>
  );
}
