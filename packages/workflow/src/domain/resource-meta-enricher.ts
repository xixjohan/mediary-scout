/**
 * 资源元数据智能提取器（策略模式）。
 *
 * 解决问题：
 * 1. 部分源（如 Prowlarr）直接提供 sizeBytes，而多数网盘聚合源（如 PanSou、爬虫源）不提供
 *    结构化 sizeBytes，但标题中往往包含明确的体积（例如 "[1080P/4.5G]"、"2160p 12.8GB"、"750MB"）；
 * 2. 部分源提供人类可读日期或 ISO 时间戳，需统一清洗归一化；
 * 3. 采用策略模式（Strategy Pattern），允许组合 RawPayloadStrategy 与 TitleRegexStrategy，
 *    以高优先级到低优先级级联降级。
 */

export interface ExtractedResourceMeta {
  sizeBytes?: number | undefined;
  postedAt?: string | undefined;
  fileCount?: number | undefined;
}

export interface ResourceMetaExtractionStrategy {
  readonly name: string;
  extract(title: string, payload?: Record<string, unknown>): Partial<ExtractedResourceMeta>;
}

const UNIT_MULTIPLIERS: Record<string, number> = {
  b: 1,
  kb: 1024,
  k: 1024,
  mb: 1024 * 1024,
  m: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  g: 1024 * 1024 * 1024,
  tb: 1024 * 1024 * 1024 * 1024,
  t: 1024 * 1024 * 1024 * 1024,
};

/**
 * 策略 A：直接读取源提供的 Raw Payload。
 */
export class RawPayloadExtractionStrategy implements ResourceMetaExtractionStrategy {
  readonly name = "raw_payload";

  extract(_title: string, payload?: Record<string, unknown>): Partial<ExtractedResourceMeta> {
    if (!payload) return {};
    const result: Partial<ExtractedResourceMeta> = {};

    const rawSize = payload["sizeBytes"];
    if (typeof rawSize === "number" && Number.isFinite(rawSize) && rawSize > 0) {
      result.sizeBytes = Math.round(rawSize);
    }

    const rawCount = payload["fileCount"];
    if (typeof rawCount === "number" && Number.isFinite(rawCount) && rawCount > 0) {
      result.fileCount = Math.round(rawCount);
    }

    const rawDate = payload["datetime"];
    if (typeof rawDate === "string" && rawDate.length > 0) {
      result.postedAt = rawDate;
    }

    return result;
  }
}

/**
 * 策略 B：从资源标题中正则提取文件大小与日期（确定性规则 fallback）。
 */
export class TitleRegexExtractionStrategy implements ResourceMetaExtractionStrategy {
  readonly name = "title_regex";

  private static readonly SIZE_REGEX =
    /(?:^|[\s/\[\(【_—\.-])(\d+(?:\.\d+)?)\s*(TB|T|GB|G|MB|M|KB|K)(?:$|[\s/\]\)】_—\.-])/i;

  private static readonly DATE_REGEX =
    /(?:^|[\s\[\(【_—\.-])(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])(?:$|[\s\]\)】_—\.-])/;

  private static readonly FILE_COUNT_REGEX =
    /(?:全|共)\s*(\d{1,4})\s*[集话話]|(\d{1,4})\s*[集话話]\s*全/;

  private parseSize(title: string): number | undefined {
    const match = TitleRegexExtractionStrategy.SIZE_REGEX.exec(title);
    if (!match || !match[1] || !match[2]) return undefined;

    const num = parseFloat(match[1]);
    const multiplier = UNIT_MULTIPLIERS[match[2].toLowerCase()];
    if (Number.isNaN(num) || !multiplier || num <= 0) return undefined;

    const bytes = Math.round(num * multiplier);
    return bytes >= 10 * 1024 && bytes <= 100 * 1024 * 1024 * 1024 * 1024 ? bytes : undefined;
  }

  private parseDate(title: string): string | undefined {
    const match = TitleRegexExtractionStrategy.DATE_REGEX.exec(title);
    if (!match || !match[1] || !match[2] || !match[3]) return undefined;

    const year = match[1];
    const month = match[2].padStart(2, "0");
    const day = match[3].padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private parseFileCount(title: string): number | undefined {
    const match = TitleRegexExtractionStrategy.FILE_COUNT_REGEX.exec(title);
    if (!match) return undefined;

    const countStr = match[1] || match[2];
    if (!countStr) return undefined;

    const count = parseInt(countStr, 10);
    return Number.isFinite(count) && count > 0 && count < 2000 ? count : undefined;
  }

  extract(title: string): Partial<ExtractedResourceMeta> {
    if (!title || typeof title !== "string") return {};

    const result: Partial<ExtractedResourceMeta> = {};
    const size = this.parseSize(title);
    if (size !== undefined) result.sizeBytes = size;

    const date = this.parseDate(title);
    if (date !== undefined) result.postedAt = date;

    const count = this.parseFileCount(title);
    if (count !== undefined) result.fileCount = count;

    return result;
  }
}

/**
 * 策略组合器（Composite Strategy）
 */
export class CompositeResourceMetaExtractor {
  private readonly strategies: ResourceMetaExtractionStrategy[];

  constructor(strategies?: ResourceMetaExtractionStrategy[]) {
    this.strategies = strategies ?? [
      new RawPayloadExtractionStrategy(),
      new TitleRegexExtractionStrategy(),
    ];
  }

  resolve(title: string, payload?: Record<string, unknown>): ExtractedResourceMeta {
    const finalMeta: ExtractedResourceMeta = {};

    for (const strategy of this.strategies) {
      const partial = strategy.extract(title, payload);
      if (finalMeta.sizeBytes === undefined && partial.sizeBytes !== undefined) {
        finalMeta.sizeBytes = partial.sizeBytes;
      }
      if (finalMeta.postedAt === undefined && partial.postedAt !== undefined) {
        finalMeta.postedAt = partial.postedAt;
      }
      if (finalMeta.fileCount === undefined && partial.fileCount !== undefined) {
        finalMeta.fileCount = partial.fileCount;
      }
      if (
        finalMeta.sizeBytes !== undefined &&
        finalMeta.postedAt !== undefined &&
        finalMeta.fileCount !== undefined
      ) {
        break;
      }
    }

    return finalMeta;
  }
}

export const defaultResourceMetaExtractor = new CompositeResourceMetaExtractor();
