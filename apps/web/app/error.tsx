"use client";

import { TriangleAlert, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

export function isChunkLoadError(error: Error): boolean {
  const message = error.message || "";
  const name = error.name || "";
  return (
    name === "ChunkLoadError" ||
    message.includes("ChunkLoadError") ||
    message.includes("Failed to load chunk") ||
    message.includes("Loading chunk") ||
    message.includes("missing chunk")
  );
}

const CHUNK_RELOAD_KEY = "mediary_chunk_reload_ts";
const COOLDOWN_MS = 15_000;

/** Root error boundary.
 *  1. When a deployment replaces chunks on disk while an active client is running,
 *     Turbopack/Webpack throws a ChunkLoadError. We catch it, debounce-reload once,
 *     and seamlessly fetch the new HTML with updated hashes.
 *  2. For true server crashes (e.g. TMDB unreachable), we provide the standard
 *     diagnostic advice and allow client-side retry.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [reloading, setReloading] = useState(false);
  const isChunk = isChunkLoadError(error);

  useEffect(() => {
    if (!isChunk || typeof window === "undefined") return;

    try {
      const lastReload = parseInt(window.sessionStorage.getItem(CHUNK_RELOAD_KEY) || "0", 10);
      const now = Date.now();
      if (!lastReload || now - lastReload > COOLDOWN_MS) {
        window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(now));
        setReloading(true);
        window.location.reload();
      }
    } catch {
      // sessionStorage blocked (private mode or sandbox) — skip auto-reload
    }
  }, [isChunk]);

  if (isChunk) {
    return (
      <div className="quiet-state" role="alert">
        <RefreshCw size={28} className={reloading ? "animate-spin" : ""} aria-hidden />
        <strong>静态资源版本更新</strong>
        <span>
          {reloading
            ? "检测到系统已发布新版本，正在为您自动刷新页面同步最新资源..."
            : "页面引用的静态资源已更新。请点击下方按钮刷新页面获取最新版本。"}
        </span>
        <button
          className="primary-button"
          type="button"
          onClick={() => {
            if (typeof window !== "undefined") {
              window.location.reload();
            }
          }}
        >
          立即刷新
        </button>
        {error.digest ? <span className="panel-note">digest: {error.digest}</span> : null}
      </div>
    );
  }

  return (
    <div className="quiet-state" role="alert">
      <TriangleAlert size={28} aria-hidden />
      <strong>页面渲染失败</strong>
      <span>
        服务端组件渲染异常。常见原因：
        <br />
        1. <strong>网络连接受阻</strong>：未配置外网代理导致无法连接 TMDB 元数据服务（大陆环境常见）。
        <br />
        2. <strong>存储卷权限不足</strong>：单 Docker 独立部署时挂载目录无写入权限（导致 SQLite 无法读写或密钥文件无法创建）。
      </span>
      <button className="primary-button" type="button" onClick={reset}>
        重试
      </button>
      <span className="panel-note">
        💡 真实错误堆栈请在服务器运行 <code>docker logs &lt;容器名&gt;</code> 查看
        {error.digest ? `（匹配 digest: ${error.digest}）` : ""}。
      </span>
    </div>
  );
}
