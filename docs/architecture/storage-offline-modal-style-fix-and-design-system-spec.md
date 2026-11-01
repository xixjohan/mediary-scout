# 网盘离线下载弹窗样式问题调研与设计系统规范

> **文档标识**: `DOC-STORAGE-OFFLINE-MODAL-STYLE-20261031`  
> **关联任务**: 修复网盘离线下载弹窗（`StorageOfflineModal`）样式错位、蒙层失效及表单控件未约束问题  
> **视觉凭证**: `media_1793446741576_1ea1c780.png`  
> **适用范围**: `apps/web/features/storage-drives/` 与全局设计系统 `apps/web/app/globals.css`

---

## 1. 问题现象与视觉凭证分析

根据用户上报的实际页面截图（`/storage` 路由下点击“新建离线下载”）：

1. **定位上下文崩塌（Context Collapse & Layout Flattening）**:
   - 弹窗未以浮层（Overlay Modal Dialog）形式居中悬浮于视口中央，也未触发暗色模糊背景蒙层（Backdrop Blur）；
   - 整个弹窗作为一个普通块级元素（`display: block; position: static`）直接挤在文件列表表格下方的普通文档流中，导致页面被无限拉长。
2. **头部元素错位折行（Header Misalignment）**:
   - 标题 `新建网盘离线下载`、网盘标签 `115网盘` 与关闭按钮 `×` 无法在同一水平线上对齐，关闭按钮掉落到第二行。
3. **表单控件排版失常（Inline Label & Narrow Textarea）**:
   - “下载链接（支持多行粘贴，每行一条）：”标签与文本输入框 `<textarea>` 左右并排（Inline 排列）；
   - `<textarea>` 未设置 `width: 100%`，回退至浏览器原始默认尺寸（仅约 150px 宽、数十像素高），出现拥挤的滚动条，体验极差。
4. **分类 Tab 与提交按钮缺乏统一玻璃拟态（Aesthetic Disconnect）**:
   - “直链 / 磁力批量添加”与“BT 种子上传”缺少现代 Segmented Control 胶囊样式；
   - 底部“取消”与“立即提交离线下载”按钮未居右对齐，与卡片边距未拉开。

---

## 2. 根因深度剖析（Root Cause Analysis）

通过对比组件代码 `apps/web/features/storage-drives/components/storage/storage-offline-modal.tsx` 与样式表 `apps/web/app/globals.css`，定位出以下核心技术根因：

### 2.1 JSX 类名与 CSS 选择器命名脱节（Class Dissociation）
在快速迭代功能时，组件与 CSS 使用了两套互相冲突的类名命名空间：

| 组件 JSX 使用类名 (`storage-offline-modal.tsx`) | 样式表声明选择器 (`globals.css`) | 匹配结果 | 导致后果 |
| :--- | :--- | :--- | :--- |
| `className="storage-modal-backdrop"` | `.storage-offline-modal-overlay` | ❌ 未匹配 | 失去 `position: fixed; inset: 0; backdrop-filter`，沦为文档流底部的普通 div |
| `className="storage-modal-card storage-offline-modal"` | `.storage-offline-modal-card` | ❌ 未匹配 | 失去固定宽度、圆角、背景卡片色与深度阴影 |
| `className="storage-modal-head"` | `.storage-offline-modal-header` | ❌ 未匹配 | 失去 `display: flex; justify-content: space-between`，导致关闭按钮换行 |
| `className="storage-modal-close"` | `.storage-offline-modal-close` | ❌ 未匹配 | 失去悬停背景态与精准居中尺寸 |
| `className="storage-offline-body"` | `.storage-offline-modal-body` | ❌ 未匹配 | 失去纵向 flex 弹性流与内边距 |
| `className="storage-offline-tab-btn"` | `.storage-offline-tab` | ❌ 未匹配 | 失去胶囊激活态色值与边框 |
| `className="storage-offline-field"` | `.storage-offline-form-group` | ❌ 未匹配 | 失去 `display: flex; flex-direction: column`，标签与输入框被迫 inline 混排 |
| `className="storage-offline-status-bar"` | `.storage-offline-status-banner` | ❌ 未匹配 | 失去成功/失败状态底色与内边距 |
| `className="storage-modal-foot"` | `.storage-modal-footer` | ❌ 未匹配 | 失去底部居右按钮组 flexbox |

### 2.2 基础表单输入框全宽约束遗漏
即使部分类名匹配，原 `.storage-offline-textarea` 仅定义了 `min-height: 90px`，未显式声明 `width: 100%; box-sizing: border-box;`。在现代 CSS 规范中，`<textarea>` 默认具备 `cols="20"` 的内联固有宽度，在没有容器 flex 列约束时必然收缩变窄。

### 2.3 门禁质检盲区（Gate Deficiency）
现有 `tools/gates/check-style-tokens.mjs` 门禁专注于：
- `:root` 未定义令牌检查（`var(--unknown)`）；
- `.storage-` 中裸 Hex 检查（强制使用三层设计令牌）。
然而，门禁尚未包含对「核心交互弹窗组件的容器类名是否真实在 CSS 中拥有定位（`position: fixed`）与尺寸样式」的静态结构断言，导致编译及单测阶段均未拦截此类纯 CSS 选择器不匹配。

---

## 3. 业界主流方案与现有库参考

### 3.1 业界主流设计标准（Radix UI / Tailwind UI / Apple Dark Glass）
1. **Dialog Overlay / Backdrop 规范**:
   - `position: fixed; inset: 0; z-index: 1000;`
   - 背景层使用高对比暗色半透明：`background: var(--bg-backdrop, rgba(0, 0, 0, 0.75));`
   - 硬件加速模糊：`backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);`
   - 弹性视口居中：`display: flex; align-items: center; justify-content: center; padding: 1.25rem;`
2. **Dialog Surface / Card 规范**:
   - `position: relative; max-width: 580px; width: 100%; max-height: calc(100vh - 4rem);`
   - 边界溢出控制：`display: flex; flex-direction: column; overflow: hidden;`
   - 视觉质感：`background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-xl); box-shadow: var(--shadow-heavy);`
3. **Form Group 规范**:
   - 表单项统一遵循竖向流式布局：`display: flex; flex-direction: column; gap: 0.5rem; width: 100%;`
   - 控件（`input`, `textarea`, `select`）必须强制 `width: 100%; box-sizing: border-box;`

### 3.2 当前系统基础设施复用（Zero-Waste Reuse）
巡影当前系统已具备极其成熟的暗色设计系统基础设施，直接复用无需引入沉重的外部组件库：
- **设计令牌池 (`globals.css:root`)**:
  - 表面色：`--bg-base`, `--bg-surface`, `--bg-raised`, `--bg-card`, `--bg-card-alt`
  - 蒙层与遮罩：`--bg-backdrop`（已包含高斯模糊适配）
  - 品牌与高亮：`--accent`, `--accent-hover`, `--accent-subtle`, `--accent-subtle-border`
  - 状态与告警：`--color-danger`, `--color-danger-subtle`, `--color-warning`, `--color-warning-subtle`
  - 圆角与阴影：`--radius-md`, `--radius-lg`, `--radius-xl`, `--radius-pill`, `--shadow-heavy`, `--shadow-glow-accent`
- **现有弹窗体系 (`storage-modals.tsx` & `acquiring-detail-modal.tsx`)**:
  - 可复用 `.acquiring-modal-backdrop` 或统一扩展 `.storage-modal-backdrop` / `.storage-offline-modal-overlay` 多别名容错；
  - 内部子组件已具有 `.storage-picker-title`, `.storage-quick-dest-row`, `.storage-quick-dest-btn` 等完备类名。

---

## 4. 具体解决方案与架构实现

### 4.1 采用双向兼容的 CSS 复合选择器体系（Bidirectional Resilient Selectors）
在 `apps/web/app/globals.css` 中重构网盘离线下载样式，采用并集选择器，同时兼容 `storage-offline-modal-*` 与通用 `storage-modal-*` 命名：

```css
/* 蒙层 Backdrop Overlay */
.storage-offline-modal-overlay,
.storage-modal-backdrop {
  position: fixed;
  inset: 0;
  background: var(--bg-backdrop, rgba(0, 0, 0, 0.72));
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1.25rem;
  animation: fadeIn var(--transition-fast) ease-out;
}

/* 弹窗主体 Card */
.storage-offline-modal-card,
.storage-modal-card.storage-offline-modal,
.storage-offline-modal {
  position: relative;
  max-width: 600px;
  width: 100%;
  max-height: calc(100vh - 4rem);
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-heavy);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: modalFadeIn var(--transition-base) cubic-bezier(0.16, 1, 0.3, 1);
}

/* 标题栏 Header */
.storage-offline-modal-header,
.storage-modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.15rem 1.35rem;
  border-bottom: 1px solid var(--divider);
  background: var(--bg-surface);
}

/* 标题复合行 Title Row */
.storage-offline-title-row {
  display: flex;
  align-items: center;
  gap: 0.625rem;
}

/* 关闭按钮 Close Button */
.storage-offline-modal-close,
.storage-modal-close {
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0.35rem;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all var(--transition-fast);
}

/* 弹窗内容滚动区 Body */
.storage-offline-modal-body,
.storage-offline-body {
  padding: 1.35rem;
  display: flex;
  flex-direction: column;
  gap: 1.15rem;
  overflow-y: auto;
}

/* 表单组与多行文本输入框 Textarea */
.storage-offline-field,
.storage-offline-form-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: 100%;
}

.storage-offline-textarea {
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 0.75rem 0.95rem;
  color: var(--text);
  font-size: 0.8125rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  line-height: 1.5;
  outline: none;
  resize: vertical;
  min-height: 110px;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

/* 底部操作栏 Footer */
.storage-offline-modal-footer,
.storage-modal-foot {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem 1.35rem;
  border-top: 1px solid var(--divider);
  background: var(--bg-surface);
}
```

### 4.2 组件代码规范化 (`storage-offline-modal.tsx`)
在 `storage-offline-modal.tsx` 中采用自洽清晰的类名体系，明确各区域语义，并对文件拖拽上传区域增加原生遮罩和状态提示。

---

## 5. 质量门禁与回归预防体系（Quality Gate & Regression Prevention）

为避免未来新增或修改弹窗组件时再次发生此类“JSX 命名了类名但在 CSS 中无对应定位规则”的缺陷，建立双重防御屏障：

1. **样式与设计令牌门禁扩展 (`tools/gates/check-style-tokens.mjs`)**:
   - 新增第 4 项检查：**弹窗组件浮层定位与约束完备性扫描**。
   - 提取 `features/storage-drives/` 下弹窗组件中使用的最外层 backdrop / overlay 类名，强制校验该类名在 `globals.css` 中必须包含：
     - `position: fixed`
     - `inset: 0` 或 `top: 0; left: 0; width: 100%; height: 100%`
     - `z-index: 1000` 或更高
     - `display: flex`
   - 校验包含的表单控件（`textarea`、`input`）必须具备 `width: 100%` 或 `box-sizing: border-box`。
2. **端对端与功能回归测试 (`tests/gates/storage-offline-modal-style.test.ts`)**:
   - 通过 AST/静态检查或无头浏览器验证：
     - 点击离线下载按钮，弹窗渲染在顶层，`position` 判定为 `fixed`，`z-index` >= 1000；
     - 文本框与目录选择按钮水平宽度占满卡片可用宽度；
     - 关闭按钮居右，标题居左对齐。

---

## 6. 执行跟踪与验收清单

| 任务项 | 负责模块 | 验证方式 | 状态 |
| :--- | :--- | :--- | :--- |
| 1. 调研与设计规范文档编写 | `docs/architecture/` | 本文档审核 | 已完成 |
| 2. CSS 全局样式重构与双向绑定 | `apps/web/app/globals.css` | 静态编译与样式校验 | 待执行 |
| 3. 组件类名与结构规范化 | `storage-offline-modal.tsx` | Next.js Turbopack 编译 | 待执行 |
| 4. 门禁与自动化断言建立 | `tools/gates/check-style-tokens.mjs` | `npm run gate:style` | 待执行 |
| 5. 页面交互与视觉验收 | Chrome DevTools 截图比对 | 视口浮层高斯模糊与居中居右检验 | 待执行 |
| 6. 全局 10 道工程门禁验收 | `npm run gate` | 10/10 门禁 100% 通过 | 待执行 |
