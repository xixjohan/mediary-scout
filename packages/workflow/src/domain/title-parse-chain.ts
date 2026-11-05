/**
 * 影视标题与季集多策略解析链 (Title & Episode Parse Strategy Chain)
 *
 * 采用策略模式 (Strategy Pattern) 与责任链模式 (Chain of Responsibility)：
 * 1. CanonicalTmdbTagStrategy (优先级 100): 提取 {tmdb-12345} 标签，置信度 100%
 * 2. StandardTitleYearFolderStrategy (优先级 80): 提取 "Title (Year)" 或 "Title.Year" 标准结构，置信度 90%
 * 3. ReleaseGroupFilenameStrategy (优先级 60): 清洗发版组标签 (1080p, WEB-DL, H265 等)，提取纯净片名与年代，置信度 75%
 * 4. AnimeFansubPatternStrategy (优先级 50): 清洗日漫 [字幕组] 标签与分辨率噪点，置信度 70%
 */

export interface TitleParseInput {
  folderName: string;
  parentCategory?: "movie" | "tv" | "anime" | "unknown" | undefined;
  sampleFileNames?: string[] | undefined;
}

export interface TitleParseResult {
  title: string;
  year?: number | undefined;
  tmdbId?: number | undefined;
  seasonNumber?: number | undefined;
  confidence: number; // 0 - 100
  strategyUsed: string;
}

export interface ITitleParseStrategy {
  readonly name: string;
  readonly priority: number;
  parse(input: TitleParseInput): TitleParseResult | null;
}

function cleanExt(name: string): string {
  return name.replace(/\.(mp4|mkv|avi|mov|wmv|flv|rmvb|ts|m2ts|webm|iso|m4v)$/i, "");
}

/**
 * 策略 1: 规范化 TMDB 标签目录 (优先级 100)
 * 形式如: "奥本海默 (2023) {tmdb-872585}" 或 "Breaking Bad {tmdb-1396}"
 */
export class CanonicalTmdbTagStrategy implements ITitleParseStrategy {
  readonly name = "CanonicalTmdbTagStrategy";
  readonly priority = 100;

  parse(input: TitleParseInput): TitleParseResult | null {
    const raw = cleanExt(input.folderName.trim());
    const match = /^(.*?)(?:\s*\((19\d\d|20\d\d)\))?\s*\{tmdb-(\d+)\}\s*$/i.exec(raw);
    if (!match) return null;

    const rawTitle = match[1]?.trim() || "";
    const rawYear = match[2];
    const rawTmdb = match[3];

    const tmdbId = rawTmdb ? Number(rawTmdb) : undefined;
    if (!tmdbId || !Number.isSafeInteger(tmdbId)) return null;

    const year = rawYear ? Number(rawYear) : undefined;
    return {
      title: rawTitle || `TMDB-${tmdbId}`,
      year,
      tmdbId,
      confidence: 100,
      strategyUsed: this.name,
    };
  }
}

/**
 * 策略 2: 行业通用标准 "标题 (年份)" 目录 (优先级 80)
 * 形式如: "肖申克的救赎 (1994)", "Inception.2010", "狂飙 (2023)"
 */
export class StandardTitleYearFolderStrategy implements ITitleParseStrategy {
  readonly name = "StandardTitleYearFolderStrategy";
  readonly priority = 80;

  parse(input: TitleParseInput): TitleParseResult | null {
    const raw = cleanExt(input.folderName.trim());
    // 匹配括号形式: "Title (2023)" 或 "[2023]"
    const parenMatch = /^(.+?)[.\s_]*[(（\[](19\d\d|20\d\d)[)）\]][.\s_]*$/i.exec(raw);
    if (parenMatch && parenMatch[1] && parenMatch[2]) {
      const title = parenMatch[1].trim();
      const year = Number(parenMatch[2]);
      if (title.length > 0 && isValidYear(year)) {
        return {
          title,
          year,
          confidence: 90,
          strategyUsed: this.name,
        };
      }
    }

    // 匹配点号或空格分隔形式: "Title.2023" 或 "Title 2023"
    const dotMatch = /^(.+?)[.\s_]+(19\d\d|20\d\d)(?:[.\s_].*)?$/i.exec(raw);
    if (dotMatch && dotMatch[1] && dotMatch[2]) {
      const title = dotMatch[1].replace(/[._]+/g, " ").trim();
      const year = Number(dotMatch[2]);
      if (title.length > 0 && isValidYear(year)) {
        return {
          title,
          year,
          confidence: 85,
          strategyUsed: this.name,
        };
      }
    }

    return null;
  }
}

const NOISE_TOKENS = [
  /2160p/gi,
  /1080p/gi,
  /720p/gi,
  /480p/gi,
  /\b4k\b/gi,
  /\buhd\b/gi,
  /\bhdr10\+?\b/gi,
  /\bdv\b/gi,
  /\bdolby\s*(?:vision|atmos)?\b/gi,
  /\bweb-?dl\b/gi,
  /\bwebrip\b/gi,
  /\bbluray\b/gi,
  /\bblu-?ray\b/gi,
  /\bremux\b/gi,
  /\bh\.?264\b/gi,
  /\bx264\b/gi,
  /\bh\.?265\b/gi,
  /\bx265\b/gi,
  /\bhevc\b/gi,
  /\baac\d*\b/gi,
  /\bdts(?:-hd)?\b/gi,
  /\btruehd\b/gi,
  /\bflac\b/gi,
  /\bmp4\b/gi,
  /\bmkv\b/gi,
  /\bcomplete\b/gi,
  /\bmulti\b/gi,
];

/**
 * 策略 3: 日本二次元动漫字幕组命名清理 (优先级 70)
 * 形式如: "[ANi] 葬送的芙莉莲 - 01 [1080P][Bilibili][WEB-DL]" 或 "[VCB-Studio] Spy x Family [01]"
 */
export class AnimeFansubPatternStrategy implements ITitleParseStrategy {
  readonly name = "AnimeFansubPatternStrategy";
  readonly priority = 70;

  parse(input: TitleParseInput): TitleParseResult | null {
    const raw = cleanExt(input.folderName.trim());
    // 必须有前置字幕组方括号 "[字幕组]" 或 "(字幕组)"
    const fansubPrefix = /^\[([^\]]+)\]\s*(.*)$/.exec(raw) || /^\(([^)]+)\)\s*(.*)$/.exec(raw);
    if (!fansubPrefix || !fansubPrefix[2]) return null;

    let content = fansubPrefix[2].trim();

    // 提取季数
    let seasonNumber: number | undefined = undefined;
    const sMatch = /[Ss](\d{1,2})/i.exec(content) || /第\s*(\d{1,2})\s*季/i.exec(content);
    if (sMatch?.[1]) {
      seasonNumber = Number(sMatch[1]);
    }

    // 截断集数标志，例如 " - 01" 或 " 01 [" 或 " E01"
    const epIndex = content.search(/\s*-\s*\d{1,4}|\s+E\d{1,4}|\s+EP?\d{1,4}/i);
    if (epIndex > 1) {
      content = content.slice(0, epIndex);
    }

    // 清洗后续的所有方括号元数据标签, 如 [1080P][Bilibili][AVC AAC]
    content = content.replace(/\[[^\]]*\]/g, " ");
    content = content.replace(/\([^)]*\)/g, " ");
    content = content.replace(/[._\-+]+/g, " ").trim();

    if (!content || content.length < 2) return null;

    return {
      title: content,
      seasonNumber,
      confidence: 70,
      strategyUsed: this.name,
    };
  }
}

function extractSeasonFromText(text: string): number | undefined {
  const match = /[Ss](\d{1,2})/i.exec(text) || /Season\s*(\d{1,2})/i.exec(text) || /第\s*(\d{1,2})\s*季/i.exec(text);
  return match?.[1] ? Number(match[1]) : undefined;
}

function extractYearFromText(text: string): number | undefined {
  const match = /(?:^|[.\s_(])(19\d\d|20\d\d)(?:[.\s_)]|$)/.exec(text);
  return match?.[1] ? Number(match[1]) : undefined;
}

function truncateAtSeasonOrYear(raw: string, year?: number): string {
  const sIndex = raw.search(/[Ss]\d{1,2}|Season\s*\d{1,2}|第\s*\d{1,2}\s*[季集]/i);
  if (sIndex > 2) {
    return raw.slice(0, sIndex);
  }
  if (year) {
    const yIndex = raw.search(new RegExp(`[.\\s_(${year}]+${year}`));
    if (yIndex > 2) {
      return raw.slice(0, yIndex);
    }
  }
  return raw;
}

function stripReleaseNoise(text: string): { cleaned: string; hasToken: boolean } {
  let cleaned = text;
  let hasToken = false;
  if (/-[A-Za-z0-9_]{3,}$/.test(cleaned)) {
    hasToken = true;
    cleaned = cleaned.replace(/-[A-Za-z0-9_]{3,}$/g, "");
  }
  for (const token of NOISE_TOKENS) {
    if (token.test(cleaned)) {
      hasToken = true;
      cleaned = cleaned.replace(token, " ");
    }
  }
  return { cleaned, hasToken };
}

/**
 * 策略 4: 发版组与种子命名清理策略 (优先级 60)
 * 形式如: "Breaking.Bad.S01.2160p.WEB-DL.H265.AAC-HDCTV" 或 "Oppenheimer.2023.IMAX.2160p"
 */
export class ReleaseGroupFilenameStrategy implements ITitleParseStrategy {
  readonly name = "ReleaseGroupFilenameStrategy";
  readonly priority = 60;

  parse(input: TitleParseInput): TitleParseResult | null {
    let raw = cleanExt(input.folderName.trim());

    const seasonNumber = extractSeasonFromText(raw);
    const year = extractYearFromText(raw);

    raw = truncateAtSeasonOrYear(raw, year);

    const { cleaned, hasToken: hasReleaseToken } = stripReleaseNoise(raw);
    raw = cleaned;

    // 发版组策略必须具备至少一个媒体特征（季序号、有效年份或发版组/编码标签）
    if (!seasonNumber && !year && !hasReleaseToken) {
      return null;
    }

    const title = raw.replace(/[._\-+]+/g, " ").trim();
    if (!title || title.length < 2) return null;

    return {
      title,
      year,
      seasonNumber,
      confidence: 75,
      strategyUsed: this.name,
    };
  }
}

function isValidYear(year: number): boolean {
  const currentYear = new Date().getFullYear();
  return Number.isInteger(year) && year >= 1895 && year <= currentYear + 3;
}

/**
 * 责任链: 按优先级组织执行所有解析策略
 */
export class TitleParseChain {
  private readonly strategies: ITitleParseStrategy[];

  constructor(customStrategies?: ITitleParseStrategy[]) {
    this.strategies = customStrategies ?? [
      new CanonicalTmdbTagStrategy(),
      new StandardTitleYearFolderStrategy(),
      new ReleaseGroupFilenameStrategy(),
      new AnimeFansubPatternStrategy(),
    ];
    this.strategies.sort((a, b) => b.priority - a.priority);
  }

  parse(input: TitleParseInput): TitleParseResult | null {
    for (const strategy of this.strategies) {
      const result = strategy.parse(input);
      if (result) {
        return result;
      }
    }
    return null;
  }
}

export function parseTitleWithChain(
  input: TitleParseInput,
  customStrategies?: ITitleParseStrategy[],
): TitleParseResult | null {
  const chain = new TitleParseChain(customStrategies);
  return chain.parse(input);
}
