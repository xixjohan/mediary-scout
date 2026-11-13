"use client";

/**
 * 剪贴板适配器（三级降级）。
 *
 * 背景：`navigator.clipboard` 只在**安全上下文**（HTTPS / localhost）存在。
 * 本项目以 HTTP + 局域网 IP 访问时它是 `undefined`，旧实现直接调用
 * `navigator.clipboard.writeText()` 会抛 TypeError，用户看到的就是「点了没反应」。
 *
 * 降级顺序：
 *   1. Clipboard API（安全上下文，首选）
 *   2. `document.execCommand("copy")` + 隐藏 textarea（HTTP 下仍被主流浏览器支持）
 *   3. 交给 UI 展示可手动复制的输入框（无法程序化写入时）
 */

export type CopyStrategy = "clipboard" | "execCommand" | "manual";

export interface CopyCapabilities {
  hasClipboard: boolean;
  hasExecCommand: boolean;
}

/** 纯函数：根据能力选择策略，便于单测与排障。 */
export function chooseCopyStrategy(caps: CopyCapabilities): CopyStrategy {
  if (caps.hasClipboard) return "clipboard";
  if (caps.hasExecCommand) return "execCommand";
  return "manual";
}

function readCapabilities(): CopyCapabilities {
  const hasClipboard =
    typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";
  const hasExecCommand =
    typeof document !== "undefined" && typeof document.execCommand === "function";
  return { hasClipboard, hasExecCommand };
}

function execCommandCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

/**
 * 尝试把文本写入剪贴板，返回实际生效的策略。
 * `manual` 表示程序化复制失败，调用方应展示可手动复制的兜底 UI。
 */
export async function copyText(text: string): Promise<CopyStrategy> {
  const strategy = chooseCopyStrategy(readCapabilities());

  if (strategy === "clipboard") {
    try {
      await navigator.clipboard.writeText(text);
      return "clipboard";
    } catch {
      // 权限被拒 / 非用户手势等场景：继续降级
    }
  }

  if (readCapabilities().hasExecCommand && execCommandCopy(text)) {
    return "execCommand";
  }

  return "manual";
}
