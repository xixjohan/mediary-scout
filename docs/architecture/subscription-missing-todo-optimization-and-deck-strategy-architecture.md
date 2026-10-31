# 订阅页「缺失待办区」视觉层级、交互逻辑与容量扩展架构设计

## 1. 背景与现状分析 (Context & Problem Statement)

在巡影（Mediary Scout）中，页面 `?tab=library` 正名为「订阅」后，核心定位转变为展示用户正在追踪、订阅的作品库及其实时就绪状况。用户进入该页面的首要关切是：**“我正在追的作品中，还有哪些集数缺失？缺了多少？如何快速查看或补齐？”**

目前系统通过 `apps/web/features/acquisition/components/subscription-todo.tsx` 提供了初步的待办看板：
```text
还缺 11 集
共 2 部 · 按缺失集数排序
- 标题 A 2024 缺 10 集
- 标题 B 2026 缺 1 集
```

### 1.1 现状核心痛点剖析

1. **纵向视口挤压风险 (Vertical Viewport Push & Layout Drift)**:
   - 当前待办区直接放置在海报墙上方 (`<SubscriptionTodo /> -> <LibraryQuickFind />`)，采用单列纯文本无限制垂直列表渲染。
   - **极端/大量缺集场景**：当资深追剧用户订阅了 30~80 部剧集，每部均存在连载或缺失集时，待办列表将占据高达 1000px+ 的垂直高度，将视觉核心的“海报墙”硬生生推挤至第二屏甚至第三屏，破坏了订阅页的整体视觉平衡。
2. **信息维度单一与认知负荷 (Lack of Visual Hierarchy & Metadata)**:
   - 纯文字呈现（标题 + 年份 + 缺 N 集），缺乏海报缩略图、就绪进度条（如 `2/12 集 · 16%`）以及紧迫度视觉标识。
   - 用户无法第一眼通过剧照/海报封面认出作品，难以快速感知完成进度。
3. **交互逻辑贫乏 (Interaction Vacuum)**:
   - 列表仅能纯跳转至详情页，不支持折叠/展开、不支持分类筛选（如仅看动漫缺集、仅看美剧缺集），亦不支持紧迫度快速切换。
4. **分类视图状态脱节 (Category Context Disconnect)**:
   - 当用户在订阅页切换顶部分类（如选择 `动漫` 或 `电视剧`）时，当前实现直接隐藏了待办区（`category === null && status !== "completed"`），导致用户在专注于特定分类时无法得知该分类下的缺集待办。

---

## 2. 业界主流对标与最佳实践 (Industry Mainstream Benchmarks)

针对追剧管理与媒体库中的“待就绪 / 缺失项目”呈现，我们对标了业界三大主流生态系统：

| 对标系统 | 方案架构 | 大量数据应对策略 | 视觉与交互亮点 |
| :--- | :--- | :--- | :--- |
| **Sonarr / Radarr** | 独立 Wanted/Cutoff 页面 + 首页紧凑监控 Widget | 表格分页 (Pagination) + 状态过滤器 | 进度环 (Progress Ring)、剧集发布日历、批量补齐 (Search Missing) |
| **Jellyfin / Emby / Plex** | 顶部“继续观看 / 下一集 / 待播甲板 (Deck)” | **横向可滑动卡片带 (Horizontal Carousel / Deck)** | **纵向高度严格固定 (140~180px)**，带缩略图与已看/已存进度条，无论有 2 部还是 50 部永不挤压下方主库 |
| **Linear / GitHub Projects** | 待办分诊抽屉 (Triage / Active Todo Tray) | **Top N 精选 (Top 4) + 平滑折叠展开抽屉 (Collapsible Tray)** | 紧迫度彩色 Pill、按分类 Tab 快速过滤、剩余数量统计 Badge |

### 2.1 结论与启示
- **恒定空间占用原则 (Bounded Vertical Real Estate)**：待办区在首屏的纵向高度必须有明确的上限，绝不能随数据量线性膨胀而无止境向下挤压海报墙。
- **甲板式视觉呈现 (Deck Presentation)**：将纯文本单列升级为现代化卡片甲板，引入海报缩略图、进度条与紧迫度徽章。
- **容量自适应与分类联动 (Adaptive Volume & Category Synchronization)**：支持 Top 4 预览 + 折叠展开，并联动分类标签（全部 / 电视剧 / 动漫 / 电影）。

---

## 3. 架构设计与设计模式融合 (Architecture & Design Patterns)

为确保代码高内聚、低耦合、便于单元测试且具备极高的可维护性，我们引入三大经典设计模式：

```
                    ┌──────────────────────────────┐
                    │   Raw LibraryWallEntry[]    │
                    └──────────────┬───────────────┘
                                   │ (Transform)
                                   ▼
                    ┌──────────────────────────────┐
                    │   MissingTodoAdapter         │
                    │   - Progress Percentage      │
                    │   - Urgency Level & Badges   │
                    │   - Category & Poster URI    │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │  MissingTodoStateMachine     │
                    │  - ViewMode: Compact/Expand  │
                    │  - Filter: All/TV/Anime/Movie│
                    └──────────────┬───────────────┘
                                   │
                                   ▼
        ┌──────────────────────────────────────────────────────┐
        │        MissingVolumeDisplayStrategy                  │
        ├──────────────────────────┬───────────────────────────┤
        │ Count <= 4 (Minimal Deck)│ Count > 4 (Expandable Deck│
        │ - 2~4 列网格全景展示     │ - Top 4 焦点卡片          │
        │ - 高饱和进度指示         │ - 展开/收起平滑抽屉       │
        │                          │ - 横向滑动 Carousel 支持  │
        └──────────────────────────┴───────────────────────────┘
```

### 3.1 适配器模式 (Adapter Pattern: `MissingTodoAdapter`)

将原始的 `LibraryWallEntry` 模型适配为富交互渲染所需的 `MissingTodoItemViewModel`：

```typescript
export type UrgencyLevel = "critical" | "moderate" | "low";

export interface MissingTodoItemViewModel {
  tmdbId: number;
  title: string;
  year: number;
  type: "movie" | "tv" | "anime";
  posterPath: string | null;
  missingAiredCount: number;
  obtainedEpisodes: number;
  totalAiredEpisodes: number;
  progressPercent: number; // 0 ~ 100
  urgencyLevel: UrgencyLevel; // critical (缺 >= 10 集或 0%), moderate (缺 3-9 集), low (缺 1-2 集)
  detailHref: string;
}
```

**适配计算逻辑**：
- **就绪进度**：`progressPercent = totalAiredEpisodes > 0 ? Math.round((obtainedEpisodes / totalAiredEpisodes) * 100) : 0`
- **紧迫度分级**：
  - `critical`：已播出但完全未入库 (`obtainedEpisodes === 0`) 或缺失集数 $\ge 10$ 集。
  - `moderate`：缺失集数在 $3 \sim 9$ 集之间。
  - `low`：仅缺 $1 \sim 2$ 集（通常为最新更新或临门一脚）。

### 3.2 策略模式 (Strategy Pattern: `MissingVolumeDisplayStrategy`)

根据待办作品的数量规模，动态采用不同的渲染表现策略：

1. **紧凑聚焦策略 (Compact Strategy - 数量 $\le 4$ 部)**：
   - 采用响应式网格 (`grid-template-columns: repeat(auto-fit, minmax(240px, 1fr))`) 一览无余地展示所有卡片。
   - 不渲染“展开/收起”按钮，保持界面清爽。
2. **可折叠扩展策略 (Expandable Deck Strategy - 数量 $> 4$ 部)**：
   - **默认状态 (Collapsed)**：仅渲染缺失最严重的 Top 4 部作品，并在底部提供交互按钮：`展开剩余 N 部 (共 M 集) ▾`。
   - **展开状态 (Expanded)**：平滑展开完整网格或列表，附带 `收起 ▴` 按钮。
   - **横向滑动支持**：卡片容器支持 `overflow-x: auto` 与 `scroll-snap-type: x mandatory`，在移动端或窄屏下保持单行滑动，杜绝纵向撑爆。

### 3.3 状态机 (State Machine: `MissingTodoStateMachine`)

使用客户端轻量级状态机管理组件的交互状态：
- **状态变量**：
  - `expanded: boolean`（折叠 vs 展开）
  - `activeCategory: "all" | "tv" | "anime" | "movie"`（分类过滤标签）
- **状态流转**：
  - 点击分类标签切换 `activeCategory` 时，即时筛选适配后的待办数据，重新计算该分类下的缺失总集数与部数。
  - 点击“展开/收起”切换 `expanded`，触发流畅的 CSS 高度过渡与 ARIA 状态更新。

---

## 4. UI 视觉规范与 CSS 架构 (Visual Design & Design Tokens)

为严格遵循项目的设计系统门禁（`check-styles.mjs`）：
- **零新裸色、零硬编码 Hex**：全部颜色必须引用系统 CSS 变量：
  - 背景：`var(--surface)`, `var(--surface-hover)`
  - 边框：`var(--border)`
  - 进度条槽：`var(--surface-hover)` 或 `var(--border)`
  - 进度填充：`var(--primary)`
  - 紧迫度高亮：`var(--accent)`, `var(--status-warning)`, `var(--status-danger)`
  - 文本层级：`var(--text)`, `var(--text-muted)`
- **无障碍与交互体验**：
  - 链接具备明确的 `focus-visible` 轮廓；
  - 展开/收起按钮具备 `aria-expanded` 属性；
  - 海报图片包含 `loading="lazy"` 与 `alt` 文本，并保持固定宽高比（2:3）避免 CLS（累积布局位移）。

---

## 5. 质量门禁与测试保障 (Quality Gates & Verification)

1. **单元测试 (`subscription-todo.test.ts`)**：
   - 验证 `MissingTodoAdapter` 正确计算百分比、紧迫度与类型标签；
   - 验证缺失集数与作品数量的多维排序稳定性；
   - 验证按分类（电视剧/动漫/电影）过滤逻辑；
   - 验证 Top 4 默认截断与展开行为。
2. **ESLint 复杂度门禁**：
   - 单函数圈复杂度不超过 15，拆分子组件与提取纯计算函数。
3. **样式门禁 (`tools/gates/check-styles.mjs`)**：
   - 运行 `npm run gate` 确保 100% 通过。
4. **端对端与无头浏览器验证 (Chrome DevTools MCP / E2E Smoke)**：
   - 访问 `http://127.0.0.1:3001/?tab=library`，验证待办甲板的卡片渲染、海报显示、进度条、折叠/展开与分类切换。
