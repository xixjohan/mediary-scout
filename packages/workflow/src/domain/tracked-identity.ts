import type { MediaTitle } from "./domain.js";

/**
 * 合成标题的 id 前缀（无作品身份的 run 记录用它承载 title）。
 *
 * 单点定义：`owner-ingest-command.ts` 用它拼 id，`isTrackedTitleIdentity` 用它
 * 把这类记录挡在「已追踪作品」之外——两处共用一份，换命名不会一边改一边漏。
 */
export const SYNTHETIC_TITLE_ID_PREFIX = "owner_ingest_" as const;

/**
 * 这条记录的作品身份**能否用于已追踪作品语义**（海报墙 / 巡检 / 取消追踪 / 策略）。
 *
 * 缺陷原型（2026-11-19 生产实测）：站长「关键字投放」在用户只给关键字时，用合成
 * `MediaTitle`（`tmdbId: 0`、id 形如 `owner_ingest_<storage>_<keyword>`）承载 run 记录
 * ——这是投放**记录**，不是作品。但读取层只排掉了 `resource_search`，于是它出现在影视库
 * 海报墙（卡片显示「0 已获 0/2 集」）、被每日巡检当成电影去 `movie_init`（白烧一次
 * LLM + 搜索），点进去落在 `/show/0` 并在 `buildMovieCandidateId` 抛
 * 「movie candidate id 必须是正整数，收到 0」，整页 500。
 *
 * 两个条件缺一不可：
 *  - `tmdbId > 0`：哨兵 0 本身就不能当作品（TMDB 没有 0 号）；
 *  - 不是合成前缀：防止将来出现「带假 id 的合成标题」时这条闸门静默放行。
 *
 * 放在读取层（repository）而不是各个 UI：至少 12 个调用点消费
 * `listTrackedSeasonStates`，逐处判等于制造 12 份不一致的机会。
 *
 * 独立成文件的理由：`domain.ts` 已顶到 600 行硬上限——把新判据塞进去会同时触发
 * 「文件超长」与「既有棘轮」两条门禁，而这条判据本身与领域类型无关。
 */
export function isTrackedTitleIdentity(title: Pick<MediaTitle, "id" | "tmdbId">): boolean {
  if (!Number.isInteger(title.tmdbId) || title.tmdbId <= 0) return false;
  return !title.id.startsWith(SYNTHETIC_TITLE_ID_PREFIX);
}
