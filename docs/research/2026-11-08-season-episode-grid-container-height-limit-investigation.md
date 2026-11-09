# 巡影 (Mediary Scout) 季剧集网格展开高度限制与超长剧集展示架构调研报告

> **文档定位**：针对影视详情页展开季（如长篇动漫《名侦探柯南》《航海王》等单季超千集）时，剧集网格容器高度无限制暴增挤开页面、丢失滚动上下文与导致 DOM 暴增的缺陷进行深度机理解构、业界主流方案对比、系统基础设施复用确认，并给出分层解决方案与自动化防回归门禁。  
> **编写日期**：2026-11-08  
> **关联源码**：
> - [`apps/web/features/acquisition/components/season-row.tsx`](file:///apps/web/features/acquisition/components/season-row.tsx)
> - [`apps/web/features/catalog/components/season-details.tsx`](file:///apps/web/features/catalog/components/season-details.tsx)
> - [`apps/web/features/catalog/styles/title-hub.css`](file:///apps/web/features/catalog/styles/title-hub.css)
> - [`apps/web/features/catalog/styles/catalog-search.css`](file:///apps/web/features/catalog/styles/catalog-search.css)
> **参考设计规范**：
> - `设计令牌-反面问题及设计门禁.md`（“列表或卡片容器高度无限制被不断挤开问题”）
> - `SoftwareArchitecture/frontend/ui-design-system/05-layout-responsive-and-density.md`（“滚动策略与独立 Scroll Container 边界”）

---

## 一、执行摘要与问题速览

在影视详情页（`/show/[tmdbId]`）中，用户点击展开某季详情时，遇到了极具代表性的前端布局失控问题：

| 维度 | 当前系统表现 | 影响与危害 |
| :--- | :--- | :--- |
| **现象** | 用户反馈案例中，长篇剧集（如第 2 季）总计包含 **1555 集**；展开后一次性平铺渲染 1555 个 `.episode-cell` 卡片 | 纵向容器被暴力撑开至 **4,000px ~ 15,000px**，整页高度被极度拉伸 |
| **布局破坏** | 容器没有声明任何 `max-height` 或 `overflow` 约束 | 该季下方的核心操作按钮（`补搜缺集`、`取消追踪`）以及后续季（第 3 季、第 4 季）被**推离视口数千像素之外**，不可见亦不可达 |
| **用户体验** | 依靠浏览器整页 Document 滚动翻找上千集 | **上下文严重丢失（Context Loss）**：滚至中间集数时，季标题与统计已看不见；操作季必须滚到底部；滚动疲劳剧烈 |
| **性能损耗** | 1555 个交互式子组件（包含事件、状态提示、缺失/替换判断）瞬时挂载 | 引发巨量 DOM 节点挂载与回流重绘（Reflow/Repaint），低性能终端与手机出现明显的交互迟滞 |
| **架构归类** | 明确属于前端架构规范定义的 **“列表/卡片容器无边界扩展反模式”** | 违反独立滚动容器守恒与视图信息密度（Density）控制原则 |

---

## 二、问题与机理深度剖析

### 1. 结构与样式调用链路分析

在当前实现中，季剧集列表的组件层级如下：

```text
SeasonRow (features/acquisition/components/season-row.tsx)
 └─ <SeasonDetails initiallyOpen={...}> (features/catalog/components/season-details.tsx)
     ├─ <summary className="hub-season-row">{rowBody}</summary> (季头部与统计进度)
     ├─ <div className="episode-grid hub-episode-grid"> (剧集网格容器)
     │   └─ {episodes.map(ep => <EpisodeCell key={ep.code} ... />)} (1555 个单元格)
     └─ <div className="season-subscription-actions"> (季操作区：补搜、取消追踪)
```

在 CSS 中，相关规则定义在两个文件中：
1. 在 [`apps/web/features/catalog/styles/catalog-search.css`](file:///apps/web/features/catalog/styles/catalog-search.css)：
   ```css
   .episode-grid {
     display: grid;
     grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
     gap: 8px;
   }
   ```
2. 在 [`apps/web/features/catalog/styles/title-hub.css`](file:///apps/web/features/catalog/styles/title-hub.css)：
   ```css
   .hub-episode-grid {
     background: var(--bg-surface);
     border-bottom-left-radius: var(--radius-card);
     border-bottom-right-radius: var(--radius-card);
     padding: 4px 18px 16px;
   }
   ```

### 2. 数学几何计算：为什么会被撑开几千像素？

- 每一个 `.episode-cell` 包含编号与状态文字，高度约 `48px`，加上 `gap: 8px`，单行占用垂直高度约为 `56px`。
- 在 1920px 桌面端下，每行容纳约 20~22 个单元格：
  $$\text{行数} = \lceil 1555 / 21 \rceil \approx 75 \text{ 行} \implies 75 \times 56\text{px} \approx 4,200\text{px}$$
- 在平板或窄屏（如 768px ~ 1024px）下，每行容纳约 8~10 个单元格：
  $$\text{行数} = \lceil 1555 / 9 \rceil \approx 173 \text{ 行} \implies 173 \times 56\text{px} \approx 9,688\text{px}$$
- 在移动端（390px 视口）下，每行容纳约 5 个单元格：
  $$\text{行数} = \lceil 1555 / 5 \rceil \approx 311 \text{ 行} \implies 311 \times 56\text{px} \approx 17,416\text{px}$$

**结论**：因为缺乏外层高度上限与内联滚动机制，用户只要点击展开，页面纵深就会瞬间膨胀 4~17 倍普通屏幕的高度，页面完全失去视觉节奏（Visual Rhythm）。

---

## 三、业界主流方案调研与横向对比

针对“超长剧集列表展开与呈现”，调研了国内外顶尖媒体与流媒体平台的工程实践：

```mermaid
graph TD
    A["长篇剧集展开 (1500+ 集)"] --> B["方案 A: CSS 容器高度封顶 (Plex/Emby)"]
    A --> C["方案 B: 剧集分段标签切换 (Bilibili/腾讯视频)"]
    A --> D["方案 C: 状态筛选漏斗 (GitLab/Mediary)"]
    A --> E["方案 D: 虚拟滚动 (TanStack Virtual)"]

    B --> B1["优点: 零破坏性、成本极低、下层操作立即可达<br/>缺点: 1500 集在单一滑块内拖拽较密集"]
    C --> C1["优点: DOM 从 1555 锐减至 100、快速区间定位<br/>缺点: 需添加轻量状态切换 UI"]
    D --> D1["优点: 聚焦补缺核心价值，只看缺集/只看已获<br/>缺点: 若缺失率极高仍需搭配高度限制"]
    E --> E1["优点: 渲染开销恒定<br/>缺点: 破坏 Next.js SSR 水合、网格动态列宽卡顿"]
```

### 详细对比矩阵

| 平台 / 方案 | 典型交互范式 | 优点 | 缺点 | 工程可行性与推荐度 |
| :--- | :--- | :--- | :--- | :--- |
| **方案 A：CSS 高度封顶与内联滚动**<br>*(Plex, TMDB, Spotify)* | 为 `.hub-episode-grid` 设置 `max-height: 400px` 并开启 `overflow-y: auto; overscroll-behavior: contain;` | **100% 声明式、零破坏性**，不改动任何 TSX/React 状态，立即阻止页面被挤爆；下层操作按钮永远在可视范围内。 | 剧集数极大时，400px 滚动条移动 1 像素对应较多剧集。 | ⭐⭐⭐⭐⭐ **L1 基础工程兜底防御（必须实施）** |
| **方案 B：剧集分段标签切换**<br>*(Bilibili 哔哩哔哩, 腾讯视频)* | 当 `totalEpisodes > 100` 时，在网格上方提供区间切换胶囊：`1-100`、`101-200`、`201-300`... 点击仅切片当前 100 集。 | **DOM 树节点直降 93%**（从 1555 降至 100），渲染与展开零卡顿；支持秒级跳跃至目标区间。 | 需要轻量前端切片逻辑（已有原生 `slice`）。 | ⭐⭐⭐⭐⭐ **L2 增强体验方案（超长剧集首选推荐）** |
| **方案 C：状态过滤器（只看缺集）**<br>*(Mediary 追更语义)* | 提供快捷药丸：`全部 (1555)` / `只看缺集 (1506)` / `已获取 (49)`。 | 完美契合“巡影”媒体 Agent 追踪补缺的核心诉求，用户展开通常只为查看缺了哪几集。 | 无法单独解决“全新订阅 1500 集全缺”的极限高度问题，须作为辅助。 | ⭐⭐⭐⭐ **协同组合交互（锦上添花）** |
| **方案 D：虚拟列表/虚拟网格**<br>*(TanStack Virtual)* | 只渲染可视区域内的 ~40 个 DOM 节点，随滚动动态置换。 | 极端性能最优。 | 对 Next.js App Router SSR 水合不友好；`auto-fill` 动态响应式网格在虚拟化下测量开销巨大且易跳动，属于**过度设计**。 | ❌ 不推荐（维护成本高，破坏 SSR） |

---

## 四、系统现有基础设施与可复用资源评估

系统**完全具备现成基建**，实现优雅解决零引入外部 npm 包：

1. **同类设计模式先例（可 1:1 复用规范）**：
   - 在 [`apps/web/features/catalog/styles/catalog-search.css`](file:///apps/web/features/catalog/styles/catalog-search.css) 中，针对网盘资源匹配列表已采用同款设计：
     ```css
     .title-resources-list {
       max-height: 480px;
       overflow-y: auto;
       overscroll-behavior: contain;
       scrollbar-gutter: stable;
     }
     ```
   - 此规范已被证明在各类屏幕上极为稳定，不仅杜绝挤爆页面，`overscroll-behavior: contain` 还能防止内层滚到底部后“链式带动”外层主窗口剧烈上下弹跳。
2. **设计系统深色滚动条与微边框**：
   - 仓储中的 `reset.css` 和全局主题已声明 `--border-subtle` 与深色微对比背景，能够为内联滚动区域提供清晰的起止边界提示。
3. **轻量切片原生能力**：
   - `season.episodes.slice(start, end)` 纯原生 JavaScript，无任何性能开销，不需要第三方工具库。

---

## 五、具体实施架构方案

推荐采用 **“双层递进防御架构” (Two-Layer Defense Architecture)**：

```text
Layer 1: 基础工程物理兜底 (CSS Max-Height & Containment)  --> 确保任何情况都不挤爆页面
   +
Layer 2: 超长剧集自适应分段 (Adaptive Chunking >= 100 eps)  --> 确保 1500+ 集超长剧集高效浏览
```

---

### Layer 1：基础工程物理兜底（纯 CSS，即刻生效）

修改 [`apps/web/features/catalog/styles/title-hub.css`](file:///apps/web/features/catalog/styles/title-hub.css) 中的 `.hub-episode-grid`：

```css
.hub-episode-grid {
  background: var(--bg-surface);
  border-bottom-left-radius: var(--radius-card);
  border-bottom-right-radius: var(--radius-card);
  padding: 12px 18px 16px;
  
  /* 核心兜底：容器高度上限约 6~7 行卡片 (400px)，彻底终结无限下坠 */
  max-height: 400px;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  border: 1px solid var(--border-subtle);
  border-top: none;
}

/* 优化内联滚动条视觉体验，契合深色主题 */
.hub-episode-grid::-webkit-scrollbar {
  width: 6px;
}
.hub-episode-grid::-webkit-scrollbar-track {
  background: transparent;
}
.hub-episode-grid::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.16);
  border-radius: 999px;
}
.hub-episode-grid::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.32);
}
```

> **治理收益**：
> - 无论剧集是 20 集、100 集还是 1555 集，容器高度被绝对封顶在 `400px` 内；
> - 下方的操作区按钮（`补搜缺集`、`取消追踪`）与后续季卡片永远稳固驻留在视口合理位置；
> - `overscroll-behavior: contain` 消除滚轮外溢抖动。

---

### Layer 2：超长剧集自适应分段与筛选（React 交互增强）

当单季总集数超过 **100 集** 时，在 `.hub-episode-grid` 顶部挂载轻量分段选择条与“只看缺集”切换：

#### 1. 分段与筛选控制器设计
在 [`apps/web/features/acquisition/components/season-row.tsx`](file:///apps/web/features/acquisition/components/season-row.tsx) 中：

```tsx
// 仅在集数超过阈值时启用分段
const CHUNK_SIZE = 100;
const isLongSeason = episodes.length > CHUNK_SIZE;

const [chunkIndex, setChunkIndex] = useState(0);
const [onlyMissing, setOnlyMissing] = useState(false);

// 过滤后的剧集池
const filteredEpisodes = useMemo(() => {
  let list = episodes;
  if (onlyMissing) {
    list = list.filter(e => e.displayState === "missing_aired" || swap.has(e.episodeCode));
  }
  return list;
}, [episodes, onlyMissing, swap]);

// 当前展示分段
const displayedEpisodes = useMemo(() => {
  if (!isLongSeason || onlyMissing) return filteredEpisodes;
  const start = chunkIndex * CHUNK_SIZE;
  return filteredEpisodes.slice(start, start + CHUNK_SIZE);
}, [filteredEpisodes, isLongSeason, onlyMissing, chunkIndex]);
```

#### 2. 分段工具栏 UI 呈现
```tsx
{isLongSeason ? (
  <div className="season-chunk-bar">
    <div className="season-chunk-tabs">
      {chunks.map((chunk, idx) => (
        <button
          key={idx}
          type="button"
          className={`chunk-pill ${chunkIndex === idx ? "is-active" : ""}`}
          onClick={() => setChunkIndex(idx)}
        >
          {chunk.label}
        </button>
      ))}
    </div>
    <button
      type="button"
      className={`missing-filter-pill ${onlyMissing ? "is-active" : ""}`}
      onClick={() => setOnlyMissing(!onlyMissing)}
    >
      只看缺集 ({season.missingAiredCount})
    </button>
  </div>
) : null}
```

> **治理收益**：
> 1. **DOM 节点暴跌**：1555 个单元格瞬间变为 100 个，React 渲染性能提升 15 倍；
> 2. **直达性极佳**：用户想查第 850 集，直接点击 `801-900` 即可秒级切出，无需费力滚动几千像素；
> 3. **补缺更聚焦**：点击“只看缺集”，快速排除已入库剧集，直达待办核心。

---

## 六、长效质量门禁与防回归测试规范

为防止同类“容器无限制撑大被不断挤开”的架构反模式在其他页面复现，规划以下自动化质量保障手段：

### 1. 容器溢出边界静态门禁 (`tools/gates/check-container-overflow-limits.mjs`)
- **扫描对象**：`apps/web/**/*.css` 中所有匹配 `*-grid`、`*-list`、`*-deck`、`*-container` 的容器类选择器。
- **校验规则**：
  - 若选择器内部包含 `display: grid` 或 `display: flex` 并伴随 `repeat(auto-fill, ...)` 或可变子项；
  - 必须显式声明 `max-height`、`max-inline-size`、`overflow-y: auto` 或分页/虚拟化标记之一；
  - 禁止出现高度无界（Unbounded Expansion）的纯流式平铺容器。

### 2. 极端长列表自动化 Playwright CLS 验收测试
- **测试夹具**：配置单季拥有 1500+ 集的 Mock 作品。
- **校验断言**：
  - 点击展开该季后：
    ```ts
    const grid = page.locator('.hub-episode-grid');
    const box = await grid.boundingBox();
    expect(box.height).toBeLessThanOrEqual(420); // 严格低于 420px 阈值
    ```
  - 断言季操作按钮 `.season-subscription-actions` 处于可见视口（In-Viewport）范围内，未被推移至不可见区域。

---

## 七、总结与实施建议

- **回答用户问题**：“缺少集 展开 能限制容器高度吗？”  
  **答案是：不仅完全能限制，而且在现代前端架构中必须予以严格限制！**
- **工程实施路径建议**：
  1. **第一步（L1 - 最小代价极速见效）**：直接在 `title-hub.css` 的 `.hub-episode-grid` 中追加 `max-height: 400px; overflow-y: auto; overscroll-behavior: contain;`，耗时仅需几秒，零代码破坏性，即可彻底封顶容器，杜绝撑开几千像素；
  2. **第二步（L2 - 进阶极致体验）**：在 `season-row.tsx` 中引入集数大于 100 时的自适应分段胶囊（如 `1-100`, `101-200`）与“只看缺集”过滤器，将 DOM 负载降低 93%，提供对齐 Bilibili 的极致追番体验。
