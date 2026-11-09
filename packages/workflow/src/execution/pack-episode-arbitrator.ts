/**
 * 大包 vs 单集智能裁决器 (Pack-Episode Arbitrator)
 *
 * 核心痛点治理：
 * 1. 解决「仅缺 1~3 集却下载 50GB 全季合集大包」的致命配额与暂存空间浪费问题；
 * 2. 避免在网盘暂存区塞入数十 GB 冗余文件，杜绝「文件每次都被丢掉」引发的容量暴涨；
 * 3. 在大面积缺集（缺失率 >= 60%）时，主动优先推荐全集合集包，用单次配额解决全季入库。
 */

export type ReleasePackKind =
  | "single_episode" // 单集 (e.g. S01E05, [05], EP05)
  | "partial_pack" // 分段包 (e.g. E01-E12, 01-12)
  | "season_pack" // 全季合集包 (e.g. S01 Complete, 全12集, 第一季 全)
  | "unknown";

export interface ReleasePackClassification {
  kind: ReleasePackKind;
  isPack: boolean;
  startEpisode?: number;
  endEpisode?: number;
  seasonNumber?: number;
}

export interface PackArbitrationInput {
  resourceName: string;
  missingEpisodesCount: number;
  totalEpisodesCount: number;
  /** 缺失率低于此阈值时，严格拒绝全季大包 (默认 0.3 即 30%) */
  fewMissingThreshold?: number;
  /** 缺失率高于此阈值时，优先全季大包 (默认 0.6 即 60%) */
  manyMissingThreshold?: number;
}

export interface PackArbitrationVerdict {
  verdict: "allow" | "reject";
  classification: ReleasePackClassification;
  missingRatio: number;
  reason?: "pack_rejected_few_missing" | "pack_preferred_many_missing" | "single_allowed" | "neutral";
  scoreModifier: number;
  explanation: string;
}

const SEASON_PACK_PATTERNS: readonly RegExp[] = [
  // S01 Complete / Season 1 Complete / S1-S3 Complete
  /\b(?:S\d{1,2}|Season\s*\d{1,2})\b.*?\b(?:Complete|全集|全\b)/i,
  /\b(?:Complete|全集)\b.*?\b(?:S\d{1,2}|Season\s*\d{1,2})\b/i,
  // 第一季 全集 / 第1季 全
  /第\s*[0-9一二三四五六七八九十]+\s*季\s*.*?(?:全集|全\b)/i,
  // [全12集] / [全24话] / [全 12 集]
  /\[?\s*全\s*\d{1,4}\s*(?:集|话|话全|集全)\s*\]?/i,
  // S01 [1080p] (无任何单独集数标识，且带有 BDRip / Web-DL Complete 特征)
  /\bS\d{1,2}\s+(?:1080p|2160p|4k|bdrip|web-dl)\b(?!.*?[Ee]\d{1,4})/i,
];

const PARTIAL_PACK_PATTERNS: readonly RegExp[] = [
  // S01E01-E12 / S01E01~E12 / S01E01-12 / E01-E12 / EP01-EP12
  /[Ss]?\d{0,2}[Ee]?(\d{1,4})\s*(?:-|~|至|_)\s*[Ee]?(\d{1,4})/i,
  // 01-12 / [01-12] / 01~12 (两组纯数字)
  /(?:\[|\b)(\d{2,4})\s*(?:-|~)\s*(\d{2,4})(?:\]|\b)/,
];

const SINGLE_EPISODE_PATTERNS: readonly RegExp[] = [
  // S01E05 / S1E5
  /[Ss]\d{1,2}[Ee](\d{1,4})\b/i,
  // EP05 / E05
  /\b(?:EP|E)(\d{1,4})\b/i,
  // 第05集 / 第5话
  /第\s*(\d{1,4})\s*(?:集|话)/i,
  // [05] / 【05】 (前后有括号包围的单集)
  /(?:\[|【|\s)(\d{2,3})(?:\]|】|\sv2|\s1080p|\s720p)/i,
];

function matchSeasonPack(trimmed: string): ReleasePackClassification | null {
  for (const pattern of SEASON_PACK_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { kind: "season_pack", isPack: true };
    }
  }
  return null;
}

function matchPartialPack(trimmed: string): ReleasePackClassification | null {
  for (const pattern of PARTIAL_PACK_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (!match?.[1] || !match[2]) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && end - start >= 1) {
      return { kind: "partial_pack", isPack: true, startEpisode: start, endEpisode: end };
    }
  }
  return null;
}

function matchSingleEpisode(trimmed: string): ReleasePackClassification | null {
  for (const pattern of SINGLE_EPISODE_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (!match?.[1]) continue;
    const epNum = Number(match[1]);
    if (Number.isFinite(epNum) && epNum > 0) {
      return { kind: "single_episode", isPack: false, startEpisode: epNum, endEpisode: epNum };
    }
  }
  return null;
}

/**
 * 识别资源名称的集数包属性
 */
export function classifyReleasePack(name: string): ReleasePackClassification {
  const trimmed = name.trim();
  if (!trimmed) {
    return { kind: "unknown", isPack: false };
  }

  return matchSeasonPack(trimmed) ?? matchPartialPack(trimmed) ?? matchSingleEpisode(trimmed) ?? { kind: "unknown", isPack: false };
}

/**
 * 裁决候选资源是否采纳，杜绝合集大包对少量缺集的配额滥用
 */
export function arbitrateReleasePack(input: PackArbitrationInput): PackArbitrationVerdict {
  const total = Math.max(1, input.totalEpisodesCount);
  const missing = Math.max(0, Math.min(input.missingEpisodesCount, total));
  const missingRatio = missing / total;

  const fewThreshold = input.fewMissingThreshold ?? 0.3;
  const manyThreshold = input.manyMissingThreshold ?? 0.6;

  const classification = classifyReleasePack(input.resourceName);

  // 场景 A: 缺失率低 (< 30%)，仅缺少 1~3 集
  if (missingRatio < fewThreshold && missingRatio > 0) {
    if (classification.kind === "season_pack") {
      const missingPct = Math.round(missingRatio * 100);
      return {
        verdict: "reject",
        classification,
        missingRatio,
        reason: "pack_rejected_few_missing",
        scoreModifier: -1000,
        explanation: `仅缺 ${missing}/${total} 集 (${missingPct}%)，已拒绝整季大包，避免数十GB冗余暂存与网盘配额浪费`,
      };
    }

    if (classification.kind === "single_episode") {
      return {
        verdict: "allow",
        classification,
        missingRatio,
        reason: "single_allowed",
        scoreModifier: 25, // 优先提拔单集
        explanation: `仅缺 ${missing}/${total} 集，单集资源精准匹配，避免冗余消耗`,
      };
    }
  }

  // 场景 B: 缺失率高 (>= 60%)，整季大面积缺失
  if (missingRatio >= manyThreshold) {
    if (classification.kind === "season_pack") {
      return {
        verdict: "allow",
        classification,
        missingRatio,
        reason: "pack_preferred_many_missing",
        scoreModifier: 50, // 大包单次离线收益极高，大幅加分
        explanation: `大面积缺失 ${missing}/${total} 集，优先整季大包一次性补全，节省离线任务配额`,
      };
    }

    if (classification.kind === "single_episode") {
      return {
        verdict: "allow",
        classification,
        missingRatio,
        reason: "neutral",
        scoreModifier: -5, // 稍稍降权单集，引导优先选用合包
        explanation: `大面积缺失 ${missing}/${total} 集，单集虽可用但多次下载较耗配额`,
      };
    }
  }

  // 默认平稳准入
  return {
    verdict: "allow",
    classification,
    missingRatio,
    reason: "neutral",
    scoreModifier: 0,
    explanation: "资源形态与当前缺集比例均衡，允许准入",
  };
}
