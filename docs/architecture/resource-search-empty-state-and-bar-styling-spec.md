# 资源检索输入框样式重构与空搜索根因调研与处理规范

> **文档标识**: `DOC-RESOURCE-SEARCH-EMPTY-DIAGNOSTICS-20261031`  
> **关联任务**: 1. 优化资源检索输入框和清空按钮样式；2. 调研并彻底解决资源搜索为空问题（以《末世行者》等为例）  
> **视觉凭证**: `media_1793447054775_8ecee63a.png`  
> **模块路径**: `apps/web/features/acquisition/`、`packages/workflow/` 与全局设计系统 `apps/web/app/globals.css`

---

## 1. 问题现象与视觉凭证分析

从用户上传的截图（在影视详情页“资源检索”面板中搜索《末世行者》）：

1. **输入框与清空按钮排版硬伤（Search Bar & Clear Button Misalignment）**:
   - 清空按钮 `×` 是一个无背景、无圆角的原生极简字符，位置被硬贴在输入框右侧边缘，甚至与右侧的“查询资源”按钮紧挨在一起（几乎发生 1px 碰撞重叠）；
   - 输入框在最右侧没有留出足够的内边距（`padding-right`），导致用户输入的文本或清空按钮在狭窄区域产生拥挤；
   - 放大镜 Search 图标使用通配 `svg` 选择器，容易受到全局 svg 样式的隐式污染。
2. **“没有找到可获取的资源”冷冰冰空态（Silent Zero-Recall & Zero Diagnostics）**:
   - 用户检索《末世行者》，直接展示一句话：“没有找到可获取的资源。”
   - 没有任何诊断说明：全网没有？源坏了？还没上映？还是关键词太严格？
   - 用户无法判断系统是否真的正常工作。

---

## 2. 根因深度剖析（Root Cause Analysis）

### 2.1 输入框与清空按钮样式缺陷
- 在 `apps/web/app/globals.css` 中：
  ```css
  .title-resources-input-wrap svg {
    position: absolute;
    left: 10px;
  }
  .title-resources-input-clear {
    position: absolute;
    right: 6px;
    padding: 4px;
  }
  ```
- **选择器过度捕获**：`.title-resources-input-wrap svg` 属于后代选择器，直接匹配了 `.title-resources-input-clear` 内部的 `<X size={12}>` SVG 图标，导致清空按钮内部图标的绝对定位属性发生意外错位；
- **缺乏工业级交互反馈**：清空按钮缺乏标准的圆形底色（Capsule Circle）、鼠标悬停（Hover / Focus）微动放大与背景高亮，在深色背景下几乎不可见；
- **输入框内边距失衡**：`padding: 6px 28px 6px 30px` 的右侧内边距仅有 28px，在高清 DPI 屏幕下，输入文本极易冲破边界遮盖清空按钮。

### 2.2 资源搜索为空的四大本质技术根因
通过深入数据库（`run/mediary.db`）与底层检索逻辑（`resolveTitleResources`、`PanSouResourceProvider`），我们发现导致“资源搜索为空”的本质原因有以下四层：

1. **根因一：搜索源（PanSou）故障/超时被静默吞掉（Silent Error Swallowing）**:
   - `PanSouResourceProvider` 在请求官方公共源（`https://so.252035.xyz`）超时或连接失败时，会将错误归入 `sourceHealth: { status: "unreachable" }`，返回空数组 `facts: []`；
   - 上层的 `buildMergedSearchSnapshot` 与 `resolveTitleResources` 收到空结果后，直接包装为 HTTP 200 `{ candidates: [], count: 0 }` 返回给前端；
   - 前端接收到空数组后只根据 `length === 0` 判定为“没有找到可获取的资源”，**导致网络中断、DNS 阻断或源离线全部被伪装成“资源不存在”**！
2. **根因二：检索目标影视尚未正式上映或尚未发布数字版（Unreleased / Future Release）**:
   - 经核验《末世行者》（The Dog Stars，TMDB ID: 1384216）：TMDB 元数据记录其上映日期为 **2026-08-26**，该片在各大院线或流媒体均未上映，全网自然不存在合法的数字或网盘分享资源；
   - 系统未根据 `releaseDate` 或作品状态给出智能化提示，用户只能困惑为何搜不到。
3. **根因三：复合修饰词过于严苛（Keyword Over-Constrained）**:
   - 许多网盘分享标题仅写了《末世行者》，若用户使用了“末世行者 4K 简日内嵌 原盘”等高阶筛选，多词联合命中率剧烈下降；
   - 系统缺乏自动阶梯回退和“一键清除修饰词重试”的交互路径。
4. **根因四：网盘类型过滤强隔离（Provider Isolation Filter）**:
   - 当用户当前绑定的网盘为 115 时，`PanSouResourceProvider` 默认只保留 115 分享链接与 magnet 磁力；如果全网仅存在夸克或百度网盘分享，这部分结果会被静默过滤掉。

---

## 3. 业界主流方案与生态参考（Industry Standard Patterns）

### 3.1 搜索输入框与清空按钮设计规范（Apple / Spotify / Radix UI）
- **左侧图标**：独立类名 `.title-resources-search-icon`，`position: absolute; left: 12px; pointer-events: none;`；
- **输入框**：强制 `padding: 8px 38px 8px 36px; border-radius: var(--radius-md); width: 100%; box-sizing: border-box;`；
- **清空按钮**：独立微型药丸设计：`position: absolute; right: 10px; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: var(--bg-surface); color: var(--text-muted); cursor: pointer;`，鼠标悬停变为 `background: var(--bg-card-alt); color: var(--text); transform: scale(1.1);`。

### 3.2 智能空状态与诊断引导（MoviePilot / Sonarr / Radix Empty State）
- **未上映拦截器（Unreleased Interceptor）**：对比当前时间与 `title.releaseDate`。若 `releaseDate > now`，以黄色友好提示展示：“⚠️ 该影视尚未正式上映（公映日期：YYYY-MM-DD），全网通常暂无数字或网盘资源”。
- **源健康度告警（Source Unreachable Alert）**：若 `sourceHealth.status === "unreachable"`，显著提示：“⚠️ 资源搜索引擎（PanSou）连接超时或无响应，请前往【设置】检查搜索源或自建源状态”。
- **去修饰词重试建议（Keyword Fallback Suggestion）**：若当前关键词包含快捷词以外的自定义修饰词，提示“未找到包含当前修饰词的资源，点击此处以原片名重试”。

---

## 4. 具体解决方案与架构实现

### 4.1 样式重构 (`globals.css` & `resource-search-bar.tsx`)
1. 规范 `resource-search-bar.tsx` 的 DOM 结构，明确赋予图标 `.title-resources-search-icon`，隔离通用 svg 选择器；
2. 为 `.title-resources-input-clear` 提供 Apple/Spotify 风格的 20px 悬浮微药丸胶囊样式；
3. 将“查询资源”按钮进行设计令牌化，悬停带微光效果与明确禁用态。

### 4.2 智能空状态组件与诊断流 (`title-resource-panel.tsx`)
在 `ResourceCandidatesList` 中，当 `candidates.length === 0` 时，替换原有的简陋文案，引入具备诊断智能的 `ResourceEmptyDiagnostic`：
1. 传入 `title`、`sourceHealth`、`currentKeyword`；
2. 计算是否为未来上映影片；
3. 计算源是否可达；
4. 渲染对应的引导卡片与重试建议按钮。

### 4.3 契约增强与源健康透传 (`TitleResourceResult`)
在 `apps/web/app/api/titles/resources/route.ts` 与 `title-resource-resolver.ts` 中：
- `buildMergedSearchSnapshot` 合并各子快照的 `sourceHealth`，不丢失连接失败诊断；
- API 响应体返回 `sourceHealth`，供前端直接展示精准的源健康状态。

---

## 5. 质量门禁与回归预防体系（Quality Gate & Regression Prevention）

1. **样式与布局门禁 (`tools/gates/check-style-tokens.mjs`)**:
   - 校验 `.title-resources-input-clear` 必须具备 `border-radius: 50%` 或 `border-radius: var(--radius-pill)`；
   - 校验 `.title-resources-input-wrap input` 必须具备足够的右侧内边距（>= 34px）。
2. **空状态智能诊断单测 (`apps/web/features/acquisition/components/resource-search-empty.test.ts`)**:
   - 验证未来上映影视展示未公映提示；
   - 验证源离线时展示源不可用引导；
   - 验证包含多余修饰词时提供回退建议。

---

## 6. 执行跟踪与验收清单

| 任务项 | 负责模块 | 验证方式 | 状态 |
| :--- | :--- | :--- | :--- |
| 1. 调研与架构设计规范编写 | `docs/architecture/` | 文档审核 | 已完成 |
| 2. 输入框与清空按钮样式重构 | `globals.css` / `resource-search-bar.tsx` | 样式与浏览器截图比对 | 待执行 |
| 3. 搜索源健康透传与合并 | `merged-search-snapshot.ts` / `route.ts` | 单元测试 | 待执行 |
| 4. 智能空状态与诊断组件实现 | `title-resource-panel.tsx` | 功能渲染测试 | 待执行 |
| 5. 样式门禁扩展与单测覆盖 | `check-style-tokens.mjs` / `*.test.ts` | `npm test` & `gate` | 待执行 |
| 6. 浏览器视觉与全链路验证 | Chrome DevTools MCP | 浏览器端截图验证 | 待执行 |
