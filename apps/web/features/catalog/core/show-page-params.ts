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
