import { JEV_UNCERTAIN_LEGEND, jevUncertaintyFlag } from "../providers/jev-judge.js";
import { isMergedSourceEvidenceUsable, type MergedSourceHealth } from "../domain/resource-source-health.js";
import type { ResourceSnapshotV2 } from "./fake-provider.js";
import { searchSnapshotWarning } from "./search-filter-diagnostics.js";

/**
 * How a snapshot is shaped before the agent sees it, plus the keyword hygiene the
 * search path applies. Split out of sandbox.ts (L0 layout ratchet: 巨型模块禁止
 * 继续堆叠代码，请拆分到独立子模块) — everything here is a pure function over a
 * snapshot or a keyword, so the sandbox keeps its tool surface and these read the
 * same wherever they are called.
 */

const QUALITY_SUBTITLE_TOKEN =
  /\b(?:4k|2160p|1080p|720p|hdr|dv|remux|web-?dl|bluray|bdrip)\b|蓝光|中字|国语|双语|字幕/gi;

const STRIP_NOTICE =
  "已从关键词移除画质/字幕词(如 4K/1080p/蓝光/中字/字幕):PanSou 是通配符匹配,加这些只会把召回打成子集或归零,raw 裸标题召回最全。已改用裸标题搜索。";

/** Threshold for large snapshot digestion hint (病3). */
const LARGE_SNAPSHOT_DIGEST_THRESHOLD = 10;

/** 预搜(raw 预热)拿到**不可用**结果(unreachable / protocol_error 快照,或 provider
 *  直接抛错)时的退避重试间隔。生产实测源抖动多在 60 秒内自愈(2026-09 前那次持续
 *  11 天的 PanSou 抖动也是间歇的),5 秒窗口的救率高;重试仍坏就落首搜那份,不无限
 *  重试。degraded / healthy 都是可用证据,一律不重试(重试只为救「真的拿不到」,不为
 *  救「次优」——重试结果可能更坏,不得把可用结果换掉)。只作用于预搜路径——agent 的
 *  searchResources 不自动重试(dedup 只信健康快照已给它自愈能力,agent 自己会
 *  换词/重搜)。 */
export const PRESEARCH_RETRY_DELAY_MS = 5000;

/** Recorded (in place of "replaced") when the agent reports an episode replaced but a
 *  file it named for that episode is not in a target dir when it reports: still in
 *  staging (never moved beside the old one), or moved in and deleted since. The episode
 *  stays 待换 (moved in and reported again, it is upgraded). */
export const REPLACEMENT_NOT_IN_TARGET_NOTE =
  "新文件不在目标目录(季目录/电影目录)里:还在暂存,或移进去后又被删掉了。不算完成替换,本轮记为未找到,留待下次巡检。";

/** 缓存快照能否当「已搜过」(dedup 的信任判据)。只有 healthy(含老快照缺字段)可信;
 *  unreachable / protocol_error / degraded 都不信,跳过缓存重打真实源。
 *
 *  degraded 不信的理由:它是 fallback 救回的「部分证据」——主源仍坏,重搜很可能
 *  拿回更全的结果;而且它的语义本身就是「证据不完整」,拿去当「已搜过、不会再变」
 *  自相矛盾。代价是一次多余的重搜(罕见且低频),换来坏快照不再永久钉死关键词。
 *
 *  与 reportNoCoverage 的证据闸( isMergedSourceEvidenceUsable,degraded 算可用)
 *  是两道边界,别互相抄:那边管「能不能报缺」——把 degraded 也拦会再也报不出真实
 *  的「没有资源」;这边只管「缓存可不可信」。 */
export function isSnapshotHealthTrusted(snapshot: ResourceSnapshotV2): boolean {
  return (snapshot.sourceHealth?.status ?? "healthy") === "healthy";
}

/** 快照算不算「有可用证据」——预搜重试的触发判据与落点择优都用它。
 *  unreachable / protocol_error(或 provider 直接抛错)才是「真的拿不到」;degraded /
 *  healthy(含老快照缺字段)都是可用证据,与 fallback-provider、reportNoCoverage 证据
 *  闸( isSourceUsable / isMergedSourceEvidenceUsable)同一套「degraded=可用」分类学。
 *  degraded 是 fallback 救回的可用快照(有候选):重试只为救「真的拿不到」,不为救
 *  「次优」——重试结果可能更坏,不得把可用结果换掉。
 *
 *  与 isSnapshotHealthTrusted(healthy-only,dedup 信任闸)是两道边界,别互相抄:
 *  那边管「缓存能不能当已搜过」,这边只管「结果值不值得为它退避重试/换掉手里的证据」。 */
export function isSnapshotEvidenceUsable(snapshot: ResourceSnapshotV2): boolean {
  return isMergedSourceEvidenceUsable(snapshot.sourceHealth);
}

/**
 * 把快照的源健康态翻成给 agent 的祈使句警告。返回 undefined 表示证据完整
 * （healthy 或老快照无此字段）——那种情形下的空候选才是权威的「确实没有」，
 * 必须保持可区分，所以这里绝不能对每个空快照都告警。
 *
 * 同一条教义见 transfer-block.ts：把系统故障报成「暂未找到资源」是拿资源
 * 给系统问题背锅（别甩锅）。unreachable 与 protocol_error 分开措辞，因为用户的
 * 处置动作不同（源挂了/网络不通 vs 地址填错了、那头根本不是 PanSou）。
 */
export function sourceHealthWarning(health: MergedSourceHealth | undefined): string | undefined {
  if (!health || health.status === "healthy") return undefined;
  const sources = health.unhealthySources.length > 0 ? health.unhealthySources.join("、") : "未知";
  switch (health.status) {
    case "degraded":
      return `搜索源「${sources}」本次未响应,只有部分源答复:本次结果是不完整证据。已返回的候选照常可用,可以正常筛选转存;但不要因为没搜到就下「没有资源」的结论,更不要据此 reportNoCoverage——缺的那部分源可能正好有。`;
    case "protocol_error":
      return `搜索源「${sources}」返回了无法解析的响应:配置的地址可能指向的根本不是 PanSou(填错地址/被网关或登录页拦截)。本次等于没搜,「没有资源」这个结论不被这份证据支持,不要 reportNoCoverage;请如实说明是搜索源配置有问题。`;
    case "unreachable":
      return `搜索源「${sources}」本次连不上,一个候选都没能取回。这是搜索源故障,不是这部片子没有资源:「没有资源」这个结论不被这份证据支持,不要 reportNoCoverage;请如实说明是搜索源不可用。`;
  }
}

/** Rows viewResourceSnapshot renders before it truncates. Shared with the presenter
 *  so the legend is gated on exactly the rows that make it into the document. */
export const RAW_SNAPSHOT_ROW_LIMIT = 120;

/** Below this many rows a majority of ⚠ can still point at something (2 of 3 is a
 *  real signal); from here on a majority means the judge could not tell. */
const JEV_FLAG_NOISE_MIN_ROWS = 10;

/** Shown in place of the flags when most rows would carry one. */
const JEV_FLAGS_SUPPRESSED_NOTE =
  "系统的片名预筛对这批候选里的大多数都拿不准是不是目标作品(长篇动画常见:字幕组的季号/总集数和 TMDB 对不上),所以本次没有逐条标 ⚠。请按标题自己判断。";

/** The tool-facing view of a snapshot: the ⚠ suffix rendered into each title (same as
 *  the 活期文档), the raw score map stripped (the agent judges titles, not numbers).
 *  Both read paths (searchResources and viewResourceSnapshot) go through here so the
 *  agent can never see two different stories about the same candidates. */
export function presentSnapshotForAgent(snapshot: ResourceSnapshotV2, limit?: number): {
  snapshot: ResourceSnapshotV2;
  legend: string | undefined;
  allDroppedWarning: string | undefined;
} {
  const scores = snapshot.prefilterScores;
  const allDroppedWarning = searchSnapshotWarning(snapshot);
  if (!scores) return { snapshot, legend: undefined, allDroppedWarning };
  // The legend explains a ⚠ the agent can SEE. viewResourceSnapshot truncates its
  // rows, so a flag past the cut must not pull in a legend for a document that has
  // no flag in it. `limit` undefined = every row is shown (searchResources).
  // A flag only helps while it singles out a few rows. On a long-running anime the
  // fansub numbering (第四季 / 总第78话) disagrees with TMDB's one-season listing, and
  // the judge doubts nearly every row (Re:从零 patrol: 150 of 155) — a ⚠ on every
  // line tells the agent nothing and costs tokens on every read. Past that point the
  // flags are dropped and one line says why.
  const flags = snapshot.candidates.map((c) => jevUncertaintyFlag(scores[c.id]));
  // Judged on the rows the agent will actually see (viewResourceSnapshot cuts at `limit`).
  const shown = limit === undefined ? flags : flags.slice(0, limit);
  const shownFlagged = shown.filter((flag) => flag !== "").length;
  if (shown.length >= JEV_FLAG_NOISE_MIN_ROWS && shownFlagged > shown.length / 2) {
    const { prefilterScores: _scores, prefilterDropped: _dropped, ...rest } = snapshot;
    return { snapshot: rest, legend: JEV_FLAGS_SUPPRESSED_NOTE, allDroppedWarning: undefined };
  }
  let flagged = 0;
  const candidates = snapshot.candidates.map((c, index) => {
    const flag = flags[index]!;
    if (flag && (limit === undefined || index < limit)) flagged += 1;
    return flag ? { ...c, title: `${c.title}${flag}` } : c;
  });
  // Both prefilter fields are stripped: the agent judges titles, not numbers, and the
  // drop count only ever reaches it through the all-dropped warning below.
  const { prefilterScores: _scores, prefilterDropped: _dropped, ...rest } = snapshot;
  return {
    snapshot: { ...rest, candidates },
    legend: flagged > 0 ? JEV_UNCERTAIN_LEGEND : undefined,
    allDroppedWarning,
  };
}

/** Strip quality/subtitle tokens from a search keyword and fold the resulting
 *  whitespace. `stripped` is true ONLY when an actual QUALITY_SUBTITLE_TOKEN was
 *  removed — NOT when mere whitespace was collapsed (so "奥本海默   第二季" does
 *  not falsely trip the strip notice). */
export function stripQualitySubtitleTokens(keyword: string): { keyword: string; stripped: boolean } {
  // QUALITY_SUBTITLE_TOKEN has the /g flag → RegExp.test() is stateful on lastIndex.
  // Reset BEFORE and after the test so a non-zero lastIndex (from any prior/concurrent
  // use of this shared regex) can never make `stripped` a false negative.
  QUALITY_SUBTITLE_TOKEN.lastIndex = 0;
  const stripped = QUALITY_SUBTITLE_TOKEN.test(keyword);
  QUALITY_SUBTITLE_TOKEN.lastIndex = 0;
  const cleaned = keyword.replace(QUALITY_SUBTITLE_TOKEN, " ").replace(/\s+/g, " ").trim();
  return { keyword: cleaned, stripped };
}

/** Whether a snapshot's candidate count is large enough to warrant the digestion hint. */
export function isLargeSnapshot(candidateCount: number): boolean {
  return candidateCount >= LARGE_SNAPSHOT_DIGEST_THRESHOLD;
}

/** The notice the agent gets when a keyword had its quality/subtitle tokens stripped. */
export function stripNoticeFor(stripped: boolean): string | undefined {
  return stripped ? STRIP_NOTICE : undefined;
}
