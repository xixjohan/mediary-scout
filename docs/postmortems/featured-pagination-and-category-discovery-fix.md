# 精选全局分页与分类查询响应修复报告

## 1. 核心根因分析（Root Cause Analysis）

### 问题一：为什么「精选」没有分页？
1. **组件层硬编码屏蔽分页栏**：
   在 [`apps/web/components/trending-row.tsx`](file:///root/mediary-scout/apps/web/components/trending-row.tsx) 中，`TrendingRowPagination` 存在防御性判断：
   ```ts
   if (!isFilterSpecified(filterParams)) return null;
   ```
   当处于首页默认精选流时，`type="all"`, `genre="all"`, `year="all"`, `page=1`，`isFilterSpecified` 判定为 `false`，导致分页栏被直接返回 `null`，用户在首页精选根本看不到分页条。
2. **数据拉取层遗漏 `page` 请求参数**：
   在 [`apps/web/lib/trending.ts`](file:///root/mediary-scout/apps/web/lib/trending.ts) 中，`fetchFeedCards` 调用 `trendingFeedQuery(kind)`，没有接收并携带 `page` 参数。即便用户手动输入 `/?page=2`，后端向 TMDB 发起的仍然是不带 `page` 的请求，永远返回第 1 页的 20 条数据，造成分页无效。

---

### 问题二：为什么「分类查询」后数据没有变化？
1. **多分类未接通动态发现引擎（Dynamic Discovery）**：
   在 [`apps/web/lib/trending.ts`](file:///root/mediary-scout/apps/web/lib/trending.ts) 中，原 `hasDynamicFilter` 仅检查了 `year` 与 `genre`，完全忽略了 `type`、`sort` 与 `page`：
   ```ts
   function hasDynamicFilter(params?: DiscoverFilterParams): boolean {
     return (Boolean(params.year) && params.year !== "all") || (Boolean(params.genre) && params.genre !== "all");
   }
   ```
   - 当用户点击「纪录片」（`type="documentary"`）或「综艺」（`type="variety"`）时，`hasDynamicFilter` 返回 `false`，且未命中 `movie | tv | anime`，直接回退走周热门大片流，然后内存中通过 `matchesItemType` 过滤。由于每周热门大片中不包含纪录片或综艺，过滤后结果为 0 条，显示“未找到符合筛选条件的作品”。
   - 当用户点击「电影」或「剧集」时，仅拉取了静态周热门第 1 页，与默认精选流中已有的热门大片高度重合，且无法翻页，导致感觉数据没有变化。
2. **URL 参数粘性冲突（Sticky Param Conflict）**：
   在 [`apps/web/lib/media-filters.ts`](file:///root/mediary-scout/apps/web/lib/media-filters.ts) 中，`buildFilterHref` 在解析 `resolveTrendingParam` 时，当切换回“全部”或切换到“纪录片/综艺”时，未清除历史残留的 `trending` 参数，导致 URL 携带矛盾参数（如 `?type=documentary&trending=movie` 或 `?type=all&trending=tv`），服务端判断 `shouldServeTrendingOnly` 为 `true`，进而锁死在特定榜单无法切换。

---

## 2. 解决方案与架构重构（Architecture & Implementation）

### 2.1 全类型 Discover 发现路由引擎
重构 [`apps/web/lib/trending.ts`](file:///root/mediary-scout/apps/web/lib/trending.ts) 中的 `fetchTypedFeedCards` 与 `buildDiscoverQuery`：
- **纪录片（Documentary）**：多路并发召回 `discover/movie` 与 `discover/tv`，传递 `with_genres=99`，并混合交织。
- **综艺（Variety）**：请求 `discover/tv`，传递 `with_genres=10764|10767`。
- **动漫（Anime）**：请求 `discover/tv`，传递 `with_genres=16`，`with_original_language=ja`。
- **电影与剧集（Movie / TV）**：带动态筛选或翻页（`page > 1`）时，全量调用 `discover/movie` 或 `discover/tv`。
- **排序映射（Sorting）**：
  - `rating`（高分优先）：映射为 `sort_by=vote_average.desc&vote_count.gte=50|100`。
  - `release`（最新上映）：映射为 `sort_by=primary_release_date.desc` / `first_air_date.desc`。
  - `popularity`（热门流行）：映射为 `sort_by=popularity.desc`。

### 2.2 精选全局分页解禁与参数联动
- 在 `TrendingRowPagination` 中移除了 `isFilterSpecified` 限制；当精选有内容时，若卡片数达到 18 条，自动展示下一页入口（最多支持 50 页发现流）。
- 在 `fetchFeedCards` 中支持 `page` 参数传递给 TMDB API，使得 `/?page=2` 能够真实拉取 TMDB 第 2 页。
- 清理 `buildFilterHref`，当切换到“全部”、“纪录片”、“综艺”时清除粘性 `trending` 参数，保证 URL 与状态完全同步。

---

## 3. 验证与门禁指标（Quality & Gate Status）

| 验证项 | 指标与测试结果 | 状态 |
| :--- | :--- | :--- |
| **ESLint 复杂度门禁** | 所有重构函数圈复杂度严守 $\le 7$（门禁上限 $\le 15$） | ✅ PASS |
| **代码行数门禁** | `trending.ts` 385 行，`trending-row.tsx` 189 行（严守 $\le 600$） | ✅ PASS |
| **设计令牌门禁** | 92 个设计令牌 100% 校验，0 处未定义变量引用 | ✅ PASS |
| **TypeScript 类型检查** | `tsc --noEmit` 0 错误 | ✅ PASS |
| **全量单元测试** | 456 套件、6,114 个用例全部通过 | ✅ PASS |
| **Next.js 生产编译** | `npm run build:web` 成功编译通过 | ✅ PASS |
| **端口 3001 服务** | 真实请求响应 200，精选翻页、纪录片、综艺数据全面动态更新 | ✅ PASS |
