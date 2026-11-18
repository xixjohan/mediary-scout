import { parseMediaFileName } from "../providers/media-title-parser.js";
import { normalizeResourceLabel } from "../domain/resource-label.js";

/**
 * 作品身份闸门（Identity Gate）。
 *
 * 背景（2026-11-17 事故）：规则只写 `1080p` 时，`matchPolicy` 对**任何** 1080p 资源
 * 都返回 matched —— 因为它的输入只有显示名，从不问「这是不是这部作品」。预览于是
 * 报出「命中 137 个」，而那 137 条来自《给你宇宙》《法警小队》《汪汪队立大功》……
 *
 * 这里补齐缺失的第一步：先判身份，再判版本。身份判定必须是**独立的前置闸门**，
 * 而不是往 mustContain 里加片名——后者换个译名就失效，还逼用户每次手抄片名。
 *
 * ## 判定顺序（便宜且不容易错的信号在前）
 *
 *   ① `{tmdb-N}` 硬锚点：明确解析到 tmdb id 且与目标不同 ⇒ 直接拒绝。
 *   ② 年份硬锚点：明确解析到年份且相差超过 1 年 ⇒ 直接拒绝。
 *      **缺年份不拒**：大量资源不带年份（本仓实测「+年份」常把召回打零）。
 *   ③ 主判定：归一化后的候选标题与目标片名（title / originalTitle / aliases）双向对齐。
 *
 * ## 为什么是「双向包含 + 词元重叠」而不是严格相等
 *
 *   · 发布名常带副标题：`The Lord of the Rings The Rings of Power S02` 与目标
 *     `指环王：力量之戒` 靠别名/原名才对得上；冒号在解析后变成空格。
 *   · 解析器会截断：`12 12 12 S01 1080p` 的 anitomy 标题是 `12`。严格相等会把
 *     真资源拒掉，所以要求「候选包含目标」或「目标包含候选」二者之一成立。
 *   · 纯数字片名（`12 12 12`）额外收紧：数字会与别处的数字撞上，必须要求归一化
 *     之后的**完整包含**，不认可零散词元重叠。
 */

/** 「是不是这部作品」所需的全部身份信息。全部字段都可缺省，缺省即不参与该条判定。 */
export interface TitleIdentity {
  tmdbId?: number | undefined;
  year?: number | undefined;
  /** 正式中文/原文名 + 原名 + 别名，任一命中即算同一部作品。 */
  titles: readonly string[];
}

/** 从候选标题里读出的可判定字段。导出以便测试逐项断言。 */
export interface CandidateIdentity {
  tmdbId: number | null;
  year: number | null;
  /** 归一化后的片名标签（去括号组/体积/发布噪声/标点/大小写）。 */
  label: string;
  /**
   * 发布名「开头那段」的归一化标签（截到第一个年份/集号/画质/size 标记之前）。
   *
   * 为什么需要它：纯数字片名（`12 12 12`）归一化成连续的 `121212`，它与发布名里
   * 的其它数字（`2026`/`S01E12`）在字符层面是连在一起的，靠「包含」判会被边界
   * 规则拒掉。而发布名的开头恰好就是片名，截出来直接相等即可。
   */
  leadingLabel: string;
  /** 解析器认出的标题；解析不出时为 null。 */
  parsedTitle: string | null;
}

const TMDB_TAG = /\{tmdb-(\d+)\}/i;
/** 年份只在 19xx / 20xx 这种真实发行年里认，避免把 1080 之类的数字当年份。 */
const YEAR_TOKEN = /(?:^|[\s._\-([（【])((?:19|20)\d{2})(?:$|[\s._\-)\]）】])/;

/** 发布名里第一个「非片名」标记的起点：年份、集号、画质、体积。 */
const NAME_MARKER = /^(?:\s*\d{4}\s*$)|(?:[Ss]\d{1,2}(?:[Ee]\d{1,4})?)|(?:\d{3,4}[pP])|(?:\d+(?:\.\d+)?\s*[GgMm][Bb])/;

/**
 * 截出发布名开头的片名段。
 *
 * 把名字按空白/分隔符切成小块，遇到第一个「明显不是片名」的块（年份 / SxxExx /
 * 1080p / 7.89GB）就停，返回之前的部分。切不出来时退回整串，让主判定兜底。
 */
export function leadingLabelOf(name: string): string {
  const chunks = name.split(/[\s._\-]+/).filter(Boolean);
  const head: string[] = [];
  for (const chunk of chunks) {
    if (NAME_MARKER.test(chunk)) break;
    // 括号包住的块（[喵萌奶茶屋] / (2026)）不算片名主体，但也不该提前截断字幕组前缀；
    // 保守起见：含括号的块跳过但不停止。
    if (/[（(【[]/.test(chunk)) continue;
    head.push(chunk);
  }
  return normalizeResourceLabel(head.join(" "));
}

export function candidateIdentityOf(name: string): CandidateIdentity {
  const tmdbMatch = TMDB_TAG.exec(name);
  const parsedTmdb = tmdbMatch?.[1] ? Number(tmdbMatch[1]) : Number.NaN;
  const parsed = parseMediaFileName(name);
  const yearFromParser = parsed.year;
  const yearFromName = Number(YEAR_TOKEN.exec(name)?.[1] ?? Number.NaN);
  const year = yearFromParser ?? (Number.isFinite(yearFromName) ? yearFromName : null);
  return {
    tmdbId: Number.isSafeInteger(parsedTmdb) ? parsedTmdb : null,
    year,
    label: normalizeResourceLabel(parsed.title ?? name),
    leadingLabel: leadingLabelOf(name),
    parsedTitle: parsed.title ?? null,
  };
}

/** 身份闸门的判定结果：matched 或 rejected(+原因说明，供审计)。 */
export type IdentityVerdict =
  | { matched: true }
  | { matched: false; detail: "tmdb_mismatch" | "year_mismatch" | "title_mismatch" };

/** 把目标作品的名字收敛成一组可比较的标签（去空、去重、归一化）。 */
function identityLabels(identity: TitleIdentity): string[] {
  const labels = new Set<string>();
  for (const raw of identity.titles) {
    const clean = raw.trim();
    if (clean.length === 0) continue;
    const label = normalizeResourceLabel(clean);
    if (label.length > 0) labels.add(label);
  }
  return [...labels];
}

function tokenize(label: string): string[] {
  // 归一化已经去掉了标点与空白，剩下的是一条连续串；为词元重叠再按「数字/字母串」切。
  return label.split(/(?<=[0-9])(?=[a-z])|(?<=[a-z])(?=[0-9])/).filter(Boolean);
}

/** 目标是否作为「完整片段」出现在候选标签里。纯数字片名必须走这一条。 */
function containsWholeLabel(candidateLabel: string, targetLabel: string): boolean {
  if (targetLabel.length === 0) return false;
  if (!candidateLabel.includes(targetLabel)) return false;
  // 纯数字目标要防止「12」在「121212026」里被当作命中：要求它在数字边界上对齐。
  if (/^[0-9]+$/.test(targetLabel)) {
    const escaped = targetLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^0-9])${escaped}(?:$|[^0-9])`).test(candidateLabel)
      || candidateLabel === targetLabel;
  }
  return true;
}

/** 词元重叠率：候选与目标共享多少连续字符块（按目标长度计）。 */
function overlapRatio(candidateLabel: string, targetLabel: string): number {
  const targetTokens = tokenize(targetLabel);
  if (targetTokens.length === 0) return 0;
  const candidateTokens = new Set(tokenize(candidateLabel));
  const hits = targetTokens.filter((token) => candidateTokens.has(token)).length;
  return hits / targetTokens.length;
}

/**
 * 候选是否属于该作品。
 *
 * 顺序即优先级：tmdb 与年份是硬锚点（明确冲突就拒，不明确则不作数）；
 * 片名是主判定（双向包含、或高词元重叠）。
 */
export function matchIdentity(identity: TitleIdentity, candidate: CandidateIdentity): IdentityVerdict {
  // ① tmdb 硬锚点：只在候选明确带 id 时比较。缺 id 不是「不匹配」的证据。
  //    相同 id 是最强的正面信号 —— 直接放行，不再看片名（发布组的改写名不参与争论）。
  if (identity.tmdbId !== undefined && candidate.tmdbId !== null) {
    if (candidate.tmdbId === identity.tmdbId) return { matched: true };
    return { matched: false, detail: "tmdb_mismatch" };
  }

  // ② 年份硬锚点：容差 1 年（跨年播出的剧很常见）。缺年份不作数。
  if (identity.year !== undefined && identity.year > 0 && candidate.year !== null) {
    if (Math.abs(candidate.year - identity.year) > 1) {
      return { matched: false, detail: "year_mismatch" };
    }
  }

  // ③ 片名主判定。目标标签集合为空（例如库里只有空名）时不让闸门否决一切——
  //    没有可比对的身份就不该假装自己判过。
  const labels = identityLabels(identity);
  if (labels.length === 0) return { matched: true };
  const candidateLabel = candidate.label;
  if (candidateLabel.length === 0) return { matched: false, detail: "title_mismatch" };

  if (labels.some((label) => labelMatches(candidate, label))) return { matched: true };
  return { matched: false, detail: "title_mismatch" };
}

/**
 * 单个目标标签 vs 候选的四条命中路径。
 *
 * 拆成独立函数是为了让 matchIdentity 读起来就是「锚点 → 主判定」两步，
 * 而不是在同一个函数里数六层嵌套。
 */
function labelMatches(candidate: CandidateIdentity, label: string): boolean {
  // 发布名开头就是片名：纯数字目标靠这一条（`12 12 12` → `121212`）。
  if (candidate.leadingLabel.length > 0 && (candidate.leadingLabel === label || candidate.leadingLabel.startsWith(label))) {
    return true;
  }
  if (containsWholeLabel(candidate.label, label)) return true;
  if (containsWholeLabel(label, candidate.label)) return true;
  // 纯数字目标只认完整包含：零散数字重叠必然撞车。
  if (/^[0-9]+$/.test(label)) return false;
  return overlapRatio(candidate.label, label) >= 0.6;
}

/** 便利封装：从显示名直接构造候选身份再判。 */
export function matchIdentityByName(identity: TitleIdentity, name: string): IdentityVerdict {
  return matchIdentity(identity, candidateIdentityOf(name));
}

/** 由 MediaTitle 形状的数据构造身份（避免 workflow 内出现双向依赖）。 */
export function titleIdentityFrom(input: {
  tmdbId?: number | null | undefined;
  year?: number | null | undefined;
  title?: string | null | undefined;
  originalTitle?: string | null | undefined;
  aliases?: readonly string[] | null | undefined;
}): TitleIdentity {
  const titles = [input.title, input.originalTitle, ...(input.aliases ?? [])]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return {
    ...(input.tmdbId !== null && input.tmdbId !== undefined && input.tmdbId > 0 ? { tmdbId: input.tmdbId } : {}),
    ...(input.year !== null && input.year !== undefined && input.year > 0 ? { year: input.year } : {}),
    titles,
  };
}
