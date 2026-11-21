/**
 * 统一剪贴板适配器（全系统单源 SSOT）。
 *
 * 背景：
 * `navigator.clipboard` 遵循 W3C 规范仅在**安全上下文**（HTTPS / localhost）暴露。
 * 私有化部署（NAS、家庭局域网通过 http://192.168.1.100:3000 访问）下属于非安全上下文，
 * `window.isSecureContext === false` 且 `navigator.clipboard === undefined`。
 * 若前端直接调用 `navigator.clipboard.writeText()` 将抛出未捕获 TypeError 导致按钮失灵。
 *
 * 降级逻辑（三级降级）：
 *   1. Clipboard API（优先，安全上下文）
 *   2. `document.execCommand("copy")` + 隐藏 `<textarea>`（局域网 HTTP 降级，覆盖所有主流现代浏览器）
 *   3. 返回 `false` / `manual`（极少数严格受限环境，交由 UI 提示用户手动选中复制）
 */

export type CopyStrategy = "clipboard" | "execCommand" | "manual";

export interface CopyResult {
  success: boolean;
  strategy: CopyStrategy;
}

/**
 * 尝试将指定文本写入操作系统剪贴板，返回布尔值。
 */
export async function copyText(text: string): Promise<boolean> {
  const result = await copyTextWithResult(text);
  return result.success;
}

/**
 * 尝试写入剪贴板并返回详细策略与执行结果。
 */
export async function copyTextWithResult(text: string): Promise<CopyResult> {
  // 1. 安全上下文探测与 Clipboard API 首选
  if (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return { success: true, strategy: "clipboard" };
    } catch {
      // 权限拒绝、页面失去焦点等，继续走降级
    }
  }

  // 2. 隐藏 Textarea + document.execCommand 兜底（支持局域网 HTTP 环境）
  if (typeof document !== "undefined" && typeof document.execCommand === "function") {
    const previous =
      typeof HTMLElement !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    // 防止页面发生可见跳动与 iOS 缩放
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "-9999px";
    area.style.fontSize = "16px";
    area.style.opacity = "0";

    document.body.appendChild(area);
    try {
      area.focus({ preventScroll: true });
      area.select();
      area.setSelectionRange(0, text.length);
      const success = document.execCommand("copy");
      if (success) {
        return { success: true, strategy: "execCommand" };
      }
    } catch {
      // execCommand 异常，进入三级降级
    } finally {
      area.remove();
      previous?.focus({ preventScroll: true });
    }
  }

  return { success: false, strategy: "manual" };
}
