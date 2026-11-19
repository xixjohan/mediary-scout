/**
 * `/show/[tmdbId]` 的查询参数解析（纯函数，无 I/O）。
 *
 * 抽出来的理由有两个，都不是"为了好看"：
 *  1. 这套解析有四个容易写错的分支（`from` 只认 search|library、`w`/`q`/`t` 要吃掉
 *     `string[]` 形态、`t` 只认三个枚举值），它们在页面里嵌在一段 30 行的流程中间，
 *     改一处很难判断有没有碰到另一处；
 *  2. 页面本身已顶到 600 行硬上限（max-lines），权限守卫必须加进那段流程里——
 *     把纯解析搬出去是唯一不需要动业务顺序的减行方式。
 */
export type ShowMediaTypeHint = "movie" | "tv" | "anime";

/**
 * `/show/<段>` 解析成 TMDB id。**非法即 null**，不留半个 id 给下游。
 *
 * 为什么把 `> 0` 放进解析而不是留在页面里：`Number.isInteger(0)` 为真，页面若只判
 * 整数，`/show/0` 会被当成一部电影走到底——渲染层最后在 `buildMovieCandidateId`
 * 抛「movie candidate id 必须是正整数」，整页 500。这正是 2026-11-19 生产事故
 * （投放的合成标题 tmdbId=0 被旧链接带进来）的落点。TMDB 没有 0 号，这里拒掉
 * 不需要任何额外信息，也不会误伤任何真实作品。
 */
export function parseTmdbIdParam(raw: string): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export interface ShowPageParams {
  /** 用户从哪个界面进来的（决定返回按钮的文案与去向）。 */
  from: "search" | "library" | null;
  /** 工作区盘 ID（来自 `?w`）。 */
  activeStorageParam: string | undefined;
  /** 搜索词（来自 `?q`）。 */
  searchQuery: string | undefined;
  /** TMDB 命名空间提示（来自 `?t`）。缺省 = 不提示，按库内命中判断。 */
  mediaTypeHint: ShowMediaTypeHint | undefined;
}

type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function resolveShowPageParams(params: RawParams): ShowPageParams {
  const fromRaw = params["from"];
  const from = fromRaw === "library" ? "library" : fromRaw === "search" ? "search" : null;

  const typeRaw = first(params["t"]);
  const mediaTypeHint =
    typeRaw === "movie" || typeRaw === "tv" || typeRaw === "anime" ? typeRaw : undefined;

  return {
    from,
    activeStorageParam: first(params["w"]),
    searchQuery: first(params["q"]),
    mediaTypeHint,
  };
}
