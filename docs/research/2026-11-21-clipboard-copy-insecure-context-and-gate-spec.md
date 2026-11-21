# 巡影 · 剪贴板复制在非安全上下文（HTTP/局域网）下的失效根因调研与统一门禁架构方案

> **文档标识**：`docs/research/2026-11-21-clipboard-copy-insecure-context-and-gate-spec.md`  
> **创建时间**：2026-11-21  
> **涉及模块**：API Key V2 管理器、客户端接入指南、敏感凭据解密弹窗、网盘串流直链、AI 助手卡片、全仓库质量门禁

---

## 1. 问题背景与现象定位

### 1.1 缺陷现象
在巡影（Mediary Scout）系统设置中，生成新的 API Key 并弹出「API Key 已就绪」弹窗后，点击「复制 Key」或「复制 JSON 配置」按钮：
- 按钮未变为「已复制」，未呈现绿色勾选态；
- 用户的操作系统剪贴板未写入任何内容；
- 开发者控制台出现未捕获异常：
  ```text
  Uncaught TypeError: Cannot read properties of undefined (reading 'writeText')
      at copyToClipboard (api-key-v2-manager.tsx:111)
  ```

### 1.2 根本原因（Root Cause Analysis）

1. **W3C 安全上下文（Secure Context）规范约束**：
   - 根据 W3C Clipboard API 规范与 MDN 文档，异步剪贴板 API `navigator.clipboard` 必须在**安全上下文**（`window.isSecureContext === true`）中运行。
   - 安全上下文仅包含：`https://*`、`http://localhost`、`http://127.0.0.1` 以及 `file:///`。
   - 当用户在私有化部署、NAS、软路由或局域网开发服务器中通过私有 IP（例如 `http://192.168.1.100:3000` 或 `http://192.168.1.100:3020`）访问时，协议为普通 HTTP 且 Host 为 IP 地址，浏览器（Chromium / Firefox / Safari）判定 `window.isSecureContext === false`。
   - 在非安全上下文中，**`navigator.clipboard` 对象直接为 `undefined`**。

2. **前端代码存在直接裸调与缺失兜底异常拦截**：
   - 在 [`apps/web/features/settings-system/components/api-key-v2-manager.tsx`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/features/settings-system/components/api-key-v2-manager.tsx) 第 110-115 行：
     ```typescript
     const copyToClipboard = (text: string) => {
       void navigator.clipboard.writeText(text).then(() => {
         setCopied(true);
         setTimeout(() => setCopied(false), 2000);
       });
     };
     ```
   - 当 `navigator.clipboard` 为 `undefined` 时，执行 `navigator.clipboard.writeText(text)` 会在属性读取阶段同步抛出 `TypeError`。由于缺少对 `navigator.clipboard` 的存在性检查，也缺少 `try...catch` 兜底，后续的 `.then(...)` 根本无法执行，导致 UI 彻底失灵。

3. **环境差异与认知盲区（开发者本地 vs 真实部署）**：
   - 开发者在本地开发测试时通常使用 `http://localhost:3000`，属于合法的安全上下文，因此 `navigator.clipboard.writeText` 能够正常工作并掩盖了该缺陷。
   - 一旦部署至私有局域网主机供真实设备或远程测试，缺陷立即暴露。

---

## 2. 业界主流方案调研与开源库对比

针对非安全上下文下的浏览器剪贴板复制，业界主流技术方案有深厚的沉淀：

| 方案 / 库 | 实现机制 | 优势 | 劣势 / 对比结论 |
| :--- | :--- | :--- | :--- |
| **`clipboard-copy`** (Feross Aboukhadijeh) | 优先 `navigator.clipboard.writeText`，若失败或不存在则降级到隐藏 `<textarea>` + `document.execCommand('copy')` | 极简、鲁棒、主流项目首选 | 仅 30 行纯代码，无需引入外部依赖包，系统内实现更受控 |
| **`copy-to-clipboard`** | 纯 `<textarea>` + `execCommand('copy')` | 历史兼容性极高 | 较老旧，不优先使用安全上下文现代 API |
| **`clipboard.js`** | 基于 DOM 事件委托与 Selection | 声明式数据绑定 | 偏重，对于现代 React 单组件内文本复制过度设计 |
| **VueUse `useClipboard`** | `isSecureContext && navigator?.clipboard` 探测，异常/降级走 `legacyCopy` | 规范、兼顾全平台与错误捕获 | 适合借鉴其架构思想为 React Hook / 单源函数 |

### 业界结论
在现代前端工程中，**无需为剪贴板功能引入额外的三方 npm 依赖**。通过自研 50 行以内、高内聚、带三级降级的单源适配函数，即可完美解决所有主流浏览器（Chrome, Firefox, Safari, Edge）在 HTTP 局域网与 HTTPS 环境下的复制需求。

---

## 3. 当前系统已有基础设施与代码资产盘点

经全仓库检索，巡影系统在过去演进中曾局部处理过剪贴板问题，但存在严重的**单源性缺失（SSOT Broken）**：

1. **[`apps/web/lib/copy-text.ts`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/lib/copy-text.ts)**：
   - 包含基本的 `window.isSecureContext && navigator.clipboard` 探测与 `document.execCommand("copy")` 隐藏 Textarea 降级实现；
   - 缺陷：未暴露策略细节、未作为全系统强约束基础库被各个特性模块强制导入。

2. **[`apps/web/features/player/clipboard.ts`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/features/player/clipboard.ts)**：
   - 为播放器量身定制了三级降级策略（`clipboard` -> `execCommand` -> `manual`），包含完整的能力探测纯函数 `chooseCopyStrategy` 与单元测试 [`apps/web/features/player/clipboard.test.ts`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/features/player/clipboard.test.ts)；
   - 缺陷：仅封存在 `features/player/` 模块内部，其他业务组件无法轻易复用。

3. **全仓库违规裸调点（共 7 处）**：
   - `apps/web/features/settings-system/components/api-key-v2-manager.tsx:111`（本次缺陷主因）
   - `apps/web/features/settings-system/components/api-key-guide-modal.tsx:148`（接入指南弹窗复制代码片段同样失效）
   - `apps/web/features/settings-system/components/api-key-panel.tsx:88`（旧版 API Key 复制）
   - `apps/web/features/storage-drives/components/storage-credentials-modal.tsx:328`（网盘敏感凭据复制）
   - `apps/web/features/storage-drives/components/storage-manager-view.tsx:371`（网盘串流直链复制）
   - `apps/web/features/assistant/components/chat-cards.tsx:99`（AI 助手卡片消息复制）
   - `apps/web/features/acquisition/hooks/use-candidate-actions.ts:197`（采集候选链复制）

---

## 4. 具体技术解决方案

### 4.1 单源适配器收敛（SSOT Consolidation）
将 [`apps/web/lib/copy-text.ts`](file:///e:/WorkProject/Node/_Project/mediary-scout/apps/web/lib/copy-text.ts) 提升为全站权威的剪贴板服务模块，统一规范：

```typescript
export type CopyStrategy = "clipboard" | "execCommand" | "manual";

export interface CopyResult {
  success: boolean;
  strategy: CopyStrategy;
}

/**
 * 全局统一安全剪贴板复制函数（三级降级）：
 * 1. 安全上下文 (HTTPS / localhost): 优先使用 navigator.clipboard.writeText()
 * 2. 非安全上下文 (HTTP 局域网 IP / 权限拒绝): 降级为隐藏 Textarea + document.execCommand("copy")
 * 3. 极少数限制环境: 返回 false / manual，以便调用方提示用户手动选中复制
 */
export async function copyText(text: string): Promise<boolean>;
export async function copyTextWithResult(text: string): Promise<CopyResult>;
```

**鲁棒性细节保证**：
- **iOS 自动缩放防御**：创建临时 `<textarea>` 时增加 `style.fontSize = "16px"`，防止移动端 iOS WebKit 触发页面放大抖动；
- **防滚动扰动**：设置 `style.position = "fixed"; style.left = "-9999px"; style.top = "0";`，并在 `focus` 时传入 `{ preventScroll: true }`；
- **清理与焦点复原**：在 `finally` 块中立即从 DOM 移除临时元素，并恢复此前处于激活状态的聚焦元素（`previous?.focus()`）；
- **只读属性与选区**：设置 `area.setAttribute("readonly", "")` 并调用 `area.select()` 与 `area.setSelectionRange(0, text.length)`，确保所有现代桌面与移动端 WebKit/Gecko 引擎可靠选中。

### 4.2 业务组件全面对齐
改造全量 7 处违规调用点，彻底移除裸写 `navigator.clipboard` 的代码，统一引入 `copyText`：
- 在 `api-key-v2-manager.tsx` 中，点击复制后依据 `await copyText(...)` 的布尔回执触发 `setCopied(true)`，若彻底失败则 `flashMessage("复制失败，请手动选中复制", true)`。

### 4.3 架构质量门禁守护（Anti-Regression Quality Gate）
为了彻底杜绝开发者日后再次在任意 UI 组件中习惯性裸写 `navigator.clipboard`，新增架构门禁：
- 新增门禁文件：[`tools/gates/check-clipboard-safety.mjs`](file:///e:/WorkProject/Node/_Project/mediary-scout/tools/gates/check-clipboard-safety.mjs)；
- **检查逻辑**：
  - 递归扫描 `apps/web/` 下所有 `.ts`, `.tsx`, `.js`, `.jsx` 文件；
  - 严格禁止直接出现 `navigator.clipboard` 或 `navigator?.clipboard`；
  - 仅白名单豁免权威适配器文件（`apps/web/lib/copy-text.ts` 与 `apps/web/features/player/clipboard.ts`）；
  - 一旦检测到裸调用，直接阻断构建并输出精准的文件行号与统一替代指引；
- 接入 `package.json` 中的 `gate:clipboard`，并编排进入主门禁流 `npm run gate`。

### 4.4 单元测试扩充
在 `apps/web/lib/copy-text.test.ts` 中补充单元测试：
- 测试安全上下文（`isSecureContext=true`）下正确调用 `navigator.clipboard.writeText`；
- 测试非安全上下文（`isSecureContext=false` 或 `navigator.clipboard` 为 `undefined`）下正确降级至 `document.execCommand('copy')` 并返回成功；
- 测试两层均异常时优雅返回 `false` / `manual`，不向外部抛出任何未捕获异常。

---

## 5. 推进执行清单（Checklist）

- [x] **调研与根因分析**：明确 W3C 安全上下文机制、全仓库排查 7 处裸调用点并完成文档化；
- [ ] **完善统一单源适配器**：增强 `apps/web/lib/copy-text.ts`，导出 `copyText` 与 `copyTextWithResult`；
- [ ] **全量业务组件收口**：重构 7 处业务组件，统一采用 `copyText`，杜绝未捕获异常；
- [ ] **编写与接入架构门禁**：新增 `tools/gates/check-clipboard-safety.mjs`，接入 `package.json`；
- [ ] **补充与运行单元测试**：编写 `copy-text.test.ts`，确保全绿；
- [ ] **全量质量门禁验证**：执行 `npm run gate`，确保全量质量门禁、`lint` 与 `typecheck` 绿灯通过；
- [ ] **本地 Linux 极速开发部署与浏览器实机验收**：部署至 `mediary-dev`（端口 3020），内置浏览器实测 API Key 弹窗复制功能；
- [ ] **正式发版与生产部署**：提交代码、撰写 Release Note、打 Tag 并部署至端口 3000 正式环境。
