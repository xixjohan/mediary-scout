/**
 * 统一网盘下载与转存协议解析与策略路由引擎 (Unified Cloud Ingest Protocol Router)
 *
 * 采用策略模式 (Strategy Pattern)，统一支持：
 * 1. 云端离线下载：MAGNET、HTTP、HTTPS、FTP、ED2K
 * 2. 多网盘秒级转存：115分享、夸克/UC分享、123云盘、天翼云盘、光鸭云盘
 * 3. 自然语言与提取码智能抽取（例如：`链接: https://... 提取码: abcd`）
 */

export type IngestProtocolType =
  | "offline"
  | "pan115_share"
  | "quark_share"
  | "pan123_share"
  | "tianyi_share"
  | "guangya_share"
  | "unknown";

export type IngestAction =
  | "offline"
  | "share_transfer"
  | "unsupported_brand"
  | "unsupported_scheme"
  | "invalid";

export interface IngestParsedItem {
  id: string;
  rawLine: string;
  url: string;
  protocol: IngestProtocolType;
  shareCode?: string | undefined;
  passcode?: string | undefined;
  action: IngestAction;
  matchedBrand?: string | undefined;
  reason: string;
  isValid: boolean;
}

export interface DriveIngestCapability {
  provider: string;
  label: string;
  supportsOffline: boolean;
  supportsTorrent: boolean;
  supportsShareTransfer: boolean;
  supportedShareBrands: string[];
  offlineSchemes: string[];
}

export const DRIVE_INGEST_CAPABILITIES: Record<string, DriveIngestCapability> = {
  pan115: {
    provider: "pan115",
    label: "115网盘",
    supportsOffline: true,
    supportsTorrent: true,
    supportsShareTransfer: true,
    supportedShareBrands: ["pan115"],
    offlineSchemes: ["magnet", "http", "https", "ftp", "ed2k"],
  },
  quark: {
    provider: "quark",
    label: "夸克网盘",
    supportsOffline: false,
    supportsTorrent: false,
    supportsShareTransfer: true,
    supportedShareBrands: ["quark"],
    offlineSchemes: [],
  },
  pan123: {
    provider: "pan123",
    label: "123云盘",
    supportsOffline: true,
    supportsTorrent: true,
    supportsShareTransfer: true,
    supportedShareBrands: ["pan123"],
    offlineSchemes: ["magnet", "http", "https", "ed2k"],
  },
  tianyi: {
    provider: "tianyi",
    label: "天翼云盘",
    supportsOffline: false,
    supportsTorrent: false,
    supportsShareTransfer: true,
    supportedShareBrands: ["tianyi"],
    offlineSchemes: [],
  },
  guangya: {
    provider: "guangya",
    label: "光鸭云盘",
    supportsOffline: true,
    supportsTorrent: false,
    supportsShareTransfer: true,
    supportedShareBrands: ["guangya"],
    offlineSchemes: ["magnet", "ed2k"],
  },
};

export function getDriveCapability(provider: string | undefined): DriveIngestCapability {
  if (!provider) {
    return {
      provider: "unknown",
      label: "未知网盘",
      supportsOffline: false,
      supportsTorrent: false,
      supportsShareTransfer: false,
      supportedShareBrands: [],
      offlineSchemes: [],
    };
  }
  return (
    DRIVE_INGEST_CAPABILITIES[provider] || {
      provider,
      label: provider,
      supportsOffline: false,
      supportsTorrent: false,
      supportsShareTransfer: false,
      supportedShareBrands: [],
      offlineSchemes: [],
    }
  );
}

function extractRawUri(trimmed: string): string {
  if (!trimmed || trimmed.startsWith("#")) {
    return "";
  }
  const match = /(https?:\/\/[^\s]+|magnet:\?[^\s]+|ed2k:\/\/[^\s]+|ftp:\/\/[^\s]+)/i.exec(trimmed);
  if (!match?.[1]) return "";
  return match[1].replace(/[)）>\]」』，。]+$/, "");
}

function extractNaturalLanguagePasscode(text: string): string | undefined {
  const match = /(?:提取码|访问码|密码|pwd|code)[:：\s]+([a-zA-Z0-9]{3,10})/i.exec(text);
  return match?.[1] ? match[1].trim() : undefined;
}

function extractUrlEmbeddedPasscode(cleanUrl: string): string | undefined {
  if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
    return undefined;
  }
  try {
    const urlObj = new URL(cleanUrl);
    const queryPass =
      urlObj.searchParams.get("pwd") ||
      urlObj.searchParams.get("password") ||
      urlObj.searchParams.get("accessCode") ||
      urlObj.searchParams.get("passcode") ||
      urlObj.searchParams.get("code");
    if (queryPass) return queryPass.trim();

    if (urlObj.hash) {
      const hashMatch = /(?:pwd|code|password)=([a-zA-Z0-9]{3,10})/i.exec(urlObj.hash);
      if (hashMatch?.[1]) return hashMatch[1].trim();
    }
  } catch {
    // 忽略格式解析异常
  }
  return undefined;
}

/**
 * 从多行文本或单行字符串中抽离出的原始 URL 与自然语言提取码
 */
export function extractUrlAndPasscode(rawLine: string): { url: string; passcode?: string | undefined } {
  const trimmed = rawLine.trim();
  const url = extractRawUri(trimmed);
  if (!url) return { url: "" };

  const passcode = extractNaturalLanguagePasscode(trimmed) || extractUrlEmbeddedPasscode(url);
  return { url, passcode };
}

interface ShareMatcher {
  protocol: IngestProtocolType;
  brand: string;
  pattern: RegExp;
  extractCode: (match: RegExpExecArray) => string | undefined;
}

const SHARE_MATCHERS: readonly ShareMatcher[] = [
  {
    protocol: "quark_share",
    brand: "quark",
    pattern: /(?:pan\.quark\.cn|drive\.uc\.cn)\/s\/([0-9a-zA-Z]+)/i,
    extractCode: (m) => m[1],
  },
  {
    protocol: "pan115_share",
    brand: "pan115",
    pattern: /(?:115\.com|anxia\.com)\/s\/([0-9a-zA-Z]+)/i,
    extractCode: (m) => m[1],
  },
  {
    protocol: "pan123_share",
    brand: "pan123",
    pattern: /(?:123pan\.com|123684\.com|123912\.cn)\/s\/([0-9a-zA-Z_-]+)/i,
    extractCode: (m) => m[1],
  },
  {
    protocol: "tianyi_share",
    brand: "tianyi",
    pattern: /cloud\.189\.cn\/(?:t\/([0-9a-zA-Z]+)|web\/share\?code=([0-9a-zA-Z]+))/i,
    extractCode: (m) => m[1] || m[2],
  },
  {
    protocol: "guangya_share",
    brand: "guangya",
    pattern: /guangyapan\.com\/s\/([0-9a-zA-Z]+)/i,
    extractCode: (m) => m[1],
  },
] as const;

function isOfflineScheme(url: string): boolean {
  return (
    url.startsWith("magnet:") ||
    url.startsWith("ed2k://") ||
    url.startsWith("ftp://") ||
    url.startsWith("http://") ||
    url.startsWith("https://")
  );
}

/**
 * 协议识别器
 */
export function detectProtocol(url: string): {
  protocol: IngestProtocolType;
  shareCode?: string | undefined;
  matchedBrand?: string | undefined;
} {
  if (!url) return { protocol: "unknown" };

  for (const matcher of SHARE_MATCHERS) {
    const match = matcher.pattern.exec(url);
    if (match) {
      const shareCode = matcher.extractCode(match);
      return { protocol: matcher.protocol, shareCode, matchedBrand: matcher.brand };
    }
  }

  if (isOfflineScheme(url)) {
    return { protocol: "offline" };
  }

  return { protocol: "unknown" };
}

/**
 * 路由策略评估单条输入
 */
export function evaluateIngestItem(
  rawLine: string,
  currentProvider: string,
  index: number
): IngestParsedItem {
  const { url, passcode } = extractUrlAndPasscode(rawLine);
  const id = `item_${index}_${Math.random().toString(36).slice(2, 7)}`;

  if (!url) {
    return {
      id,
      rawLine,
      url: "",
      protocol: "unknown",
      action: "invalid",
      reason: "无效链接或空行",
      isValid: false,
    };
  }

  const { protocol, shareCode, matchedBrand } = detectProtocol(url);
  const driveCap = getDriveCapability(currentProvider);

  // 1. 如果是网盘分享链接
  if (protocol !== "offline" && protocol !== "unknown") {
    if (driveCap.supportedShareBrands.includes(matchedBrand || "")) {
      return {
        id,
        rawLine,
        url,
        protocol,
        shareCode,
        passcode,
        action: "share_transfer",
        matchedBrand,
        reason: `${driveCap.label}分享链接秒级转存`,
        isValid: true,
      };
    }
    const otherLabel = matchedBrand ? getDriveCapability(matchedBrand).label : "其它网盘";
    return {
      id,
      rawLine,
      url,
      protocol,
      shareCode,
      passcode,
      action: "unsupported_brand",
      matchedBrand,
      reason: `该链接属于【${otherLabel}】，当前选择的网盘是【${driveCap.label}】，请切换网盘后再转存`,
      isValid: false,
    };
  }

  // 2. 如果是离线下载协议 (magnet/http/ed2k 等)
  if (protocol === "offline") {
    if (driveCap.supportsOffline) {
      return {
        id,
        rawLine,
        url,
        protocol,
        action: "offline",
        reason: `${driveCap.label}云端离线下载`,
        isValid: true,
      };
    }
    return {
      id,
      rawLine,
      url,
      protocol,
      action: "unsupported_scheme",
      reason: `【${driveCap.label}】不支持离线下载功能，推荐切换至 115网盘 或 123云盘`,
      isValid: false,
    };
  }

  return {
    id,
    rawLine,
    url,
    protocol: "unknown",
    action: "invalid",
    reason: "未能识别支持的下载或分享协议",
    isValid: false,
  };
}

export interface BatchIngestResult {
  items: IngestParsedItem[];
  validCount: number;
  offlineCount: number;
  shareCount: number;
  errorCount: number;
  hasUnsupported: boolean;
  summaryMessage: string;
}

/**
 * 批量文本解析与策略评估
 */
export function parseBatchIngestInput(input: string, currentProvider: string): BatchIngestResult {
  const lines = input
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  const items = lines.map((line, idx) => evaluateIngestItem(line, currentProvider, idx));

  let validCount = 0;
  let offlineCount = 0;
  let shareCount = 0;
  let errorCount = 0;
  let hasUnsupported = false;

  for (const it of items) {
    if (it.isValid) {
      validCount++;
      if (it.action === "offline") offlineCount++;
      if (it.action === "share_transfer") shareCount++;
    } else {
      errorCount++;
      if (it.action === "unsupported_brand" || it.action === "unsupported_scheme") {
        hasUnsupported = true;
      }
    }
  }

  let summaryMessage = "";
  if (items.length === 0) {
    summaryMessage = "请粘贴下载直链、磁力或网盘分享链接";
  } else if (validCount === items.length) {
    summaryMessage = `就绪：${validCount} 个任务已解析（${shareCount} 个秒级转存，${offlineCount} 个云端离线）`;
  } else {
    summaryMessage = `已解析 ${items.length} 条：${validCount} 个可用，${errorCount} 个异常或不匹配`;
  }

  return {
    items,
    validCount,
    offlineCount,
    shareCount,
    errorCount,
    hasUnsupported,
    summaryMessage,
  };
}
