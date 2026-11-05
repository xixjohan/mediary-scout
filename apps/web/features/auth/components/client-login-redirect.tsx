"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * 客户端安全自动跳转组件：
 * 1. 在 React 客户端挂载与 SPA 导航生命周期中，通过 useEffect 确保 100% 触发 window.location.replace；
 * 2. 在服务端 SSR 阶段下发带有全屏遮罩的 DOM 节点，阻断底层未授权空数据视图闪现；
 * 3. 客户端使用 createPortal 挂载到顶层 document.body，符合模态与浮层层叠规范；
 * 4. 内嵌 meta refresh 与 script 作为 SSR 直连双重兜底。
 */
export function ClientLoginRedirect({ target = "/login" }: { target?: string }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (typeof window !== "undefined" && window.location.pathname !== "/login") {
      const destination =
        target === "/login" && window.location.pathname && window.location.pathname !== "/"
          ? `/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`
          : target;
      window.location.replace(destination);
    }
  }, [target]);

  const overlay = (
    <div
      className="login-redirect-overlay"
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 99999,
        backgroundColor: "var(--bg-base, #121212)",
        pointerEvents: "all",
      }}
    >
      <meta httpEquiv="refresh" content={`0;url=${target}`} />
      <script
        dangerouslySetInnerHTML={{
          __html: `window.location.replace(${JSON.stringify(target)});`,
        }}
      />
    </div>
  );

  if (mounted && typeof document !== "undefined") {
    return createPortal(overlay, document.body);
  }

  return overlay;
}
