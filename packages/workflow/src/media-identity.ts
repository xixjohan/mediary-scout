/**
 * 媒体身份：单一出处。
 *
 * ## 这个模块为什么存在
 *
 * 方案 §2.2 的原话是「媒体身份必须带来源前缀」，但实测本项目产出的 id **本来**就带
 * （`tmdb_tv_283428` / `tmdb_movie_238`）。真正的缺口是三件事：
 *
 *   1. 没有 `MediaSource` 类型。来源只是字符串里的一段，任何代码都能拼出另一种格式而
 *      编译器无感——接第二个源时，拼错的那一处不会报错，只会静默错配。
 *   2. 5 种 id 格式由约 10 处模板字面量构造、3 处手写正则解析，散在 8 个文件，且正则
 *      已有细微差异：`demo-candidates.ts` 写 `/^tmdb_tv_(\d+)_s\d+$/`，
 *      `workflow-runtime.ts` 写 `/^tmdb_tv_(\d+)_s(\d+)$/`——同一格式两份写法。
 *   3. 解析失败一律返回裸 `null`。「id 写错了」和「这片不在库里」在上层无法区分，
 *      于是调用方各自发挥。
 *
 * ## wire format 不变，因此没有数据库迁移
 *
 * `media_titles` / `tracked_seasons` / `user_messages` / `resource_snapshots` 都按
 * title_key 索引，改格式等于换主键。本模块只把「怎么拼、怎么拆」收敛到一处，
 * 拼出来的字符串与今天逐字节相同，旧行原样可读。这也是方案说「现在改是一行类型的
 * 代价」的真实含义：格式那一层早已付过，剩下要付的是类型层。
 *
 * ## 加第二个源时要动哪里
 *
 * 往 `MediaSource` 联合里加一个成员。`MEDIA_SOURCES` 用 `satisfies` 收口，加成员时
 * `assertExhaustive` 的调用点会编译报错——是**显式动作**，不是顺手加个字符串。
 */

/** 元数据来源。包含 TMDB 与 豆瓣（douban）；加新源是显式动作（见 assertExhaustive）。 */
export type MediaSource = "tmdb" | "douban";

/** 全部来源。用 `satisfies` 而非 `: MediaSource[]`——后者会宽化成 string[]，断言变同义反复。 */
export const MEDIA_SOURCES = ["tmdb", "douban"] satisfies readonly MediaSource[];

/** 媒体种类。title id 用；candidate id 已由格式本身区分 movie/tv。 */
export type MediaKind = "tv" | "movie";

/** title id，如 `tmdb_tv_283428` / `tmdb_movie_238`。 */
export type MediaTitleId = string & { readonly __brand: "MediaTitleId" };
/** movie candidate id，如 `tmdb_movie_238`。 */
export type MovieCandidateId = string & { readonly __brand: "MovieCandidateId" };
/** tv candidate id，如 `tmdb_tv_283428_s1`。 */
export type TvCandidateId = string & { readonly __brand: "TvCandidateId" };
/** trackedSeason id，如 `tmdb_tv_283428_s1`（今天与 TvCandidateId 同格式，语义不同）。 */
export type TrackedSeasonId = string & { readonly __brand: "TrackedSeasonId" };

/** 解析失败的原因。**绝不返回裸 null**——那会让「id 写错了」和「查无此片」无法区分。 */
export type MediaIdParseReason =
  /** 来源前缀不在已知集合里（未来 `douban_1295644` 落到旧二进制上）。 */
  | "unknown_source"
  /** 结构对但内容畸形：空串、非数字、数字形态不对（00 / 1e3 / 超长）。 */
  | "malformed"
  /** 是个合法 id，但不是这个种类（如把 trackedSeason id 喂给 parseTitleId）。 */
  | "not_a_title_id"
  | "not_a_movie_candidate_id"
  | "not_a_tv_candidate_id"
  | "not_a_tracked_season_id";

export type MediaIdParseResult<T> = { ok: true; value: T } | { ok: false; reason: MediaIdParseReason };

export function isMediaSource(value: string): value is MediaSource {
  return (MEDIA_SOURCES as readonly string[]).includes(value);
}

/**
 * 穷尽性收口：`MediaSource` 加了成员而这里没分支时，返回类型变成 `never`，
 * 调用处赋值失败 ⇒ 编译报错。防止「顺手加个字符串」。
 */
export function assertExhaustive(source: never): never {
  throw new Error(`unhandled media source: ${String(source)}`);
}

const DIGITS = /^\d+$/;

/** 正整数校验：拒绝 0、负数、小数、NaN、Infinity、以及 `1e3` 形态的字符串。 */
function assertPositiveInt(value: number, what: string): void {
  if (!Number.isInteger(value) || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${what} 必须是正整数，收到 ${String(value)}`);
  }
}

/**
 * 来源的 wire 前缀。**穷尽 switch 落在这里而不是测试里**，是因为 workflow 包的
 * tsconfig include 只收了 src 目录——tests/ 从来不被 tsc 检查，放在测试里的编译期
 * 断言是空的（本次已实证：根 tsconfig 能扫出 37 个测试文件类型错误，而 gate 一个
 * 都看不到）。
 *
 * 加第二个源时必须在这里决定它的前缀，这是真实的决定而不是走个形式：MP 的
 * `themovdb+550` 用 `+` 分隔，与本项目的 `_` 不同，分隔符归属来源。
 */
export function sourcePrefix(source: MediaSource): string {
  switch (source) {
    case "tmdb":
      return "tmdb";
    case "douban":
      return "douban";
    default:
      return assertExhaustive(source);
  }
}

export function buildTitleId(input: {
  source: MediaSource;
  mediaKind: MediaKind;
  id: number;
}): MediaTitleId {
  assertPositiveInt(input.id, "title id");
  return `${sourcePrefix(input.source)}_${input.mediaKind}_${input.id}` as MediaTitleId;
}

export function buildMovieCandidateId(input: { source: MediaSource; id: number }): MovieCandidateId {
  assertPositiveInt(input.id, "movie candidate id");
  return `${sourcePrefix(input.source)}_movie_${input.id}` as MovieCandidateId;
}

export function buildTvCandidateId(input: {
  source: MediaSource;
  id: number;
  seasonNumber: number;
}): TvCandidateId {
  assertPositiveInt(input.id, "tv candidate id");
  assertPositiveInt(input.seasonNumber, "seasonNumber");
  return `${sourcePrefix(input.source)}_tv_${input.id}_s${input.seasonNumber}` as TvCandidateId;
}

export function buildTrackedSeasonId(input: {
  source: MediaSource;
  id: number;
  seasonNumber: number;
}): TrackedSeasonId {
  assertPositiveInt(input.id, "tracked season id");
  assertPositiveInt(input.seasonNumber, "seasonNumber");
  return `${sourcePrefix(input.source)}_tv_${input.id}_s${input.seasonNumber}` as TrackedSeasonId;
}

/**
 * 前后空白一律报 `malformed`，不报 `unknown_source`。
 *
 * 这不是措辞洁癖：`unknown_source` 对运维的含义是「出现了第二个元数据源，得决定怎么
 * 处理」；而 `" tmdb_tv_283428 "` 的真实成因是数据在某一环被污染了。把后者报成前者
 * 会让人去查根本不存在的新源，从而放过真正的污染点。
 */
function hasSurroundingWhitespace(id: string): boolean {
  return id !== id.trim();
}

/** 拆出 `来源_其余`。来源不在已知集合 ⇒ `unknown_source`（不是 null）。 */
function splitSource(id: string): { source: MediaSource; rest: string } | { reason: "unknown_source" } {
  const underscore = id.indexOf("_");
  // 没有下划线 = 连「来源_其余」的结构都没有，属畸形而非未知来源。
  if (underscore <= 0) return { reason: "unknown_source" };
  const source = id.slice(0, underscore);
  if (!isMediaSource(source)) return { reason: "unknown_source" };
  return { source, rest: id.slice(underscore + 1) };
}

/**
 * 数字必须是规范十进制且在安全整数内。
 *
 * 上界不是洁癖：`Number("99999999999999999999")` 会丢精度，解析出的值与原始串不再
 * 一一对应，`build(parse(id))` 会返回**另一个** id——那正是本模块要防的静默错配。
 */
function parseDigits(text: string): number | null {
  if (!DIGITS.test(text)) return null;
  if (text.length > 1 && text.startsWith("0")) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** 这个 id 属于哪一种已知格式。用于区分「另一种合法 id」与「畸形」。 */
type IdShape = "title" | "movieCandidate" | "tvCandidate" | "trackedSeason";

function classifyShape(source: MediaSource, rest: string): IdShape | null {
  const prefix = `${source}_`;
  const full = `${prefix}${rest}`;
  if (/^[a-z]+_(?:tv|movie)_\d+$/.test(full)) return "title";
  if (/^[a-z]+_movie_\d+$/.test(full)) return "movieCandidate";
  if (/^[a-z]+_tv_\d+_s\d+$/.test(full)) return "tvCandidate";
  return null;
}

const TITLE_RE = /^(tv|movie)_(\d+)$/;
const MOVIE_RE = /^movie_(\d+)$/;
const TV_RE = /^tv_(\d+)_s(\d+)$/;

export function parseTitleId(
  id: string,
): MediaIdParseResult<{ source: MediaSource; mediaKind: MediaKind; id: number }> {
  if (id === "" || hasSurroundingWhitespace(id)) return { ok: false, reason: "malformed" };
  const head = splitSource(id);
  if ("reason" in head) {
    // 空串/无下划线已先行拦掉；走到这里说明来源前缀真的不认识。
    return { ok: false, reason: head.reason };
  }
  const match = TITLE_RE.exec(head.rest);
  if (!match) {
    const shape = classifyShape(head.source, head.rest);
    // 形状是另一种合法 id ⇒ 明确说「不是 title id」，别让调用方以为数据坏了。
    if (shape !== null && shape !== "title") return { ok: false, reason: "not_a_title_id" };
    return { ok: false, reason: "malformed" };
  }
  const digits = parseDigits(match[2]!);
  if (digits === null) return { ok: false, reason: "malformed" };
  return { ok: true, value: { source: head.source, mediaKind: match[1] as MediaKind, id: digits } };
}

export function parseMovieCandidateId(
  id: string,
): MediaIdParseResult<{ source: MediaSource; id: number }> {
  if (id === "" || hasSurroundingWhitespace(id)) return { ok: false, reason: "malformed" };
  const head = splitSource(id);
  if ("reason" in head) return { ok: false, reason: head.reason };
  const match = MOVIE_RE.exec(head.rest);
  if (!match) {
    const shape = classifyShape(head.source, head.rest);
    if (shape !== null && shape !== "movieCandidate") {
      return { ok: false, reason: "not_a_movie_candidate_id" };
    }
    return { ok: false, reason: "malformed" };
  }
  const digits = parseDigits(match[1]!);
  if (digits === null) return { ok: false, reason: "malformed" };
  return { ok: true, value: { source: head.source, id: digits } };
}

function parseSeasonLike(
  id: string,
  notThisKind: "not_a_tv_candidate_id" | "not_a_tracked_season_id",
): MediaIdParseResult<{ source: MediaSource; id: number; seasonNumber: number }> {
  if (id === "" || hasSurroundingWhitespace(id)) return { ok: false, reason: "malformed" };
  const head = splitSource(id);
  if ("reason" in head) return { ok: false, reason: head.reason };
  const match = TV_RE.exec(head.rest);
  if (!match) {
    const shape = classifyShape(head.source, head.rest);
    if (shape !== null && shape !== "tvCandidate" && shape !== "trackedSeason") {
      return { ok: false, reason: notThisKind };
    }
    return { ok: false, reason: "malformed" };
  }
  const idDigits = parseDigits(match[1]!);
  const seasonDigits = parseDigits(match[2]!);
  if (idDigits === null || seasonDigits === null) return { ok: false, reason: "malformed" };
  return { ok: true, value: { source: head.source, id: idDigits, seasonNumber: seasonDigits } };
}

export function parseTvCandidateId(
  id: string,
): MediaIdParseResult<{ source: MediaSource; id: number; seasonNumber: number }> {
  return parseSeasonLike(id, "not_a_tv_candidate_id");
}

export function parseTrackedSeasonId(
  id: string,
): MediaIdParseResult<{ source: MediaSource; id: number; seasonNumber: number }> {
  return parseSeasonLike(id, "not_a_tracked_season_id");
}
