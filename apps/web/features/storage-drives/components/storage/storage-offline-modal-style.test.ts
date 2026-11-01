import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("StorageOfflineModal 样式与布局完整性防回归测试", () => {
  const root = resolve(process.cwd());
  const cssPath = resolve(root, "apps/web/app/globals.css");
  const tsxPath = resolve(
    root,
    "apps/web/features/storage-drives/components/storage/storage-offline-modal.tsx",
  );

  const cssContent = readFileSync(cssPath, "utf8");
  const tsxContent = readFileSync(tsxPath, "utf8");

  it("TSX 弹窗浮层类名与 CSS 规则精确匹配，严禁再次脱节", () => {
    // 弹窗蒙层类名必须存在于 TSX 与 CSS 中
    expect(tsxContent).toContain("storage-offline-modal-overlay");
    expect(cssContent).toContain(".storage-offline-modal-overlay");

    // 弹窗卡片类名必须存在于 TSX 与 CSS 中
    expect(tsxContent).toContain("storage-offline-modal-card");
    expect(cssContent).toContain(".storage-offline-modal-card");

    // 弹窗头部与关闭按钮类名必须匹配
    expect(tsxContent).toContain("storage-offline-modal-header");
    expect(cssContent).toContain(".storage-offline-modal-header");
    expect(tsxContent).toContain("storage-offline-modal-close");
    expect(cssContent).toContain(".storage-offline-modal-close");
  });

  it("蒙层选择器必须具备固定的视口居中与高斯模糊遮罩属性", () => {
    const overlayBlockMatch = cssContent.match(/\.storage-offline-modal-overlay[^{]*\{([^}]+)\}/);
    expect(overlayBlockMatch).not.toBeNull();
    const overlayRules = overlayBlockMatch![1]!;

    expect(overlayRules).toContain("position: fixed");
    expect(overlayRules).toContain("inset: 0");
    expect(overlayRules).toContain("backdrop-filter");
    expect(overlayRules).toContain("display: flex");
    expect(overlayRules).toContain("align-items: center");
    expect(overlayRules).toContain("justify-content: center");
  });

  it("文本输入框 textarea 必须具备 100% 全宽约束与 border-box，防止视觉缩成极窄块", () => {
    const textareaBlockMatch = cssContent.match(/\.storage-offline-textarea[^{]*\{([^}]+)\}/);
    expect(textareaBlockMatch).not.toBeNull();
    const textareaRules = textareaBlockMatch![1]!;

    expect(textareaRules).toContain("width: 100%");
    expect(textareaRules).toContain("box-sizing: border-box");
    expect(textareaRules).toContain("resize: vertical");
  });

  it("头部 header 必须使用 flex 空间分布，防止关闭按钮被迫折行掉落", () => {
    const headerBlockMatch = cssContent.match(/\.storage-offline-modal-header[^{]*\{([^}]+)\}/);
    expect(headerBlockMatch).not.toBeNull();
    const headerRules = headerBlockMatch![1]!;

    expect(headerRules).toContain("display: flex");
    expect(headerRules).toContain("justify-content: space-between");
    expect(headerRules).toContain("align-items: center");
  });

  it("双向兼容性断言：同时兼容 storage-modal-backdrop 通用命名空间", () => {
    expect(cssContent).toContain(".storage-modal-backdrop");
    expect(cssContent).toContain(".storage-modal-card");
    expect(cssContent).toContain(".storage-modal-head");
    expect(cssContent).toContain(".storage-modal-foot");
  });
});
