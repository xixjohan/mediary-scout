/**
 * 统一网盘下载与转存协议解析与策略路由引擎 (Unified Cloud Ingest Protocol Router)
 *
 * 采用策略模式 (Strategy Pattern)，统一支持：
 * 1. 云端离线下载：MAGNET、HTTP、HTTPS、FTP、ED2K
 * 2. 多网盘秒级转存：115分享、夸克/UC分享、123云盘、天翼云盘、光鸭云盘
 * 3. 自然语言与提取码智能抽取（例如：`链接: https://... 提取码: abcd`）
 *
 * **能力不在这里声明**：支持哪些协议/品牌由 `STORAGE_BRANDS.ingest`
 * （packages/workflow/src/storage/ingest-capabilities.ts）决定，服务端提交也读
 * 同一份。本模块只做「给定能力，判定这一行能不能提交」的纯函数路由——它曾经
 * 手写过第二份能力表，结果 UC 盘在注册表里存在、在这里被当成未知网盘。
 */
import { getIngestCapability, type IngestCapability } from "@media-track/workflow";

export type IngestProtocolType =
  | "offline"
  | "pan115_share"
  | "quark_share"
  | "uc_share"
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

/** 前端展示用：由注册表派生的能力视图（与服务端 GET 响应同形）。 */
export interface DriveIngestCapability {
  provider: string;
  label: string;
  supportsOffline: boolean;
  supportsTorrent: boolean;
  supportsTorrentFile: boolean;
  supportsShareTransfer: boolean;
  supportedShareBrands: string[];
  offlineSchemes: string[];
}

function toDriveCapability(capability: IngestCapability): DriveIngestCapability {
  return {
    provider: capability.provider,
    label: capability.label,
    supportsOffline: capability.supportsOffline,
    supportsTorrent: capability.supportsTorrent,
    supportsTorrentFile: capability.supportsTorrentFile,
    supportsShareTransfer: capability.supportsShareTransfer,
    supportedShareBrands: [...capability.supportedShareBrands],
    offlineSchemes: [...capability.offlineSchemes],
  };
}

/** 该盘的能力。数据源是注册表，不再是手写字面量表。 */
export function getDriveCapability(provider: string | undefined): DriveIngestCapability {
  return toDriveCapability(getIngestCapability(provider));
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

/** 分享链品牌识别。UC 与夸克同族但**不是同一个品牌**：把 drive.uc.cn 认成
 *  quark 会让夸克盘接受一条它解析不了的链接（parseCloudFamilyShareUrl 的
 *  shareHostPattern 是 profile 级的，夸克 profile 只认 pan.quark.cn）。 */
const SHARE_MATCHERS: readonly ShareMatcher[] = [
  {
    protocol: "quark_share",
    brand: "quark",
    pattern: /pan\.quark\.cn\/s\/([0-9a-zA-Z]+)/i,
    extractCode: (m) => m[1],
  },
  {
    protocol: "uc_share",
    brand: "uc",
    pattern: /drive\.uc\.cn\/s\/([0-9a-zA-Z]+)/i,
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

function schemeOf(url: string): string {
  const at = url.indexOf(":");
  return at > 0 ? url.slice(0, at).toLowerCase() : "";
}

/**
 * 路由策略评估单条输入。
 *
 * `capability` 由调用方传入（服务端 = 注册表；前端 = GET 响应的能力视图），
 * 因此「哪些能提交」只有一个来源。
 */
export function evaluateIngestItem(
  rawLine: string,
  currentProvider: string,
  index: number,
  capability?: DriveIngestCapability,
): IngestParsedItem {
  const { url, passcode } = extractUrlAndPasscode(rawLine);
  const id = `item_${index}_${Math.random().toString(36).slice(2, 7)}`;
  const cap = capability ?? getDriveCapability(currentProvider);

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

  // 1. 如果是网盘分享链接
  if (protocol !== "offline" && protocol !== "unknown") {
    if (cap.supportsShareTransfer && cap.supportedShareBrands.includes(matchedBrand || "")) {
      return {
        id,
        rawLine,
        url,
        protocol,
        shareCode,
        passcode,
        action: "share_transfer",
        matchedBrand,
        reason: `${cap.label}分享链接秒级转存`,
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
      reason: `该链接属于【${otherLabel}】，当前选择的网盘是【${cap.label}】，请切换网盘后再转存`,
      isValid: false,
    };
  }

  // 2. 如果是离线下载协议 (magnet/http/ed2k 等)
  if (protocol === "offline") {
    const scheme = schemeOf(url);
    if (cap.supportsOffline && cap.offlineSchemes.includes(scheme)) {
      return {
        id,
        rawLine,
        url,
        protocol,
        action: "offline",
        reason: `${cap.label}云端离线下载`,
        isValid: true,
      };
    }
    const schemeLabel = scheme === "http" || scheme === "https" ? "HTTP 直链" : `${scheme.toUpperCase()} 链接`;
    return {
      id,
      rawLine,
      url,
      protocol,
      action: "unsupported_scheme",
      reason: cap.supportsOffline
        ? `【${cap.label}】不支持${schemeLabel}离线，可用协议：${cap.offlineSchemes.join(" / ").toUpperCase()}`
        : `【${cap.label}】不支持离线下载功能，推荐切换至 115网盘 或 123云盘`,
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
export function parseBatchIngestInput(
  input: string,
  currentProvider: string,
  capability?: DriveIngestCapability,
): BatchIngestResult {
  const lines = input
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  const cap = capability ?? getDriveCapability(currentProvider);
  const items = lines.map((line, idx) => evaluateIngestItem(line, currentProvider, idx, cap));

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

/** 把服务端能力响应投影成本模块的视图（形状一致，避免两处各自定义）。 */
export function capabilityFromServer(view: {
  provider: string;
  supportsOffline: boolean;
  supportsTorrent: boolean;
  supportsTorrentFile?: boolean;
  supportsShareTransfer: boolean;
  supportedShareBrands: string[];
  schemes: string[];
}): DriveIngestCapability {
  return {
    provider: view.provider,
    label: getDriveCapability(view.provider).label,
    supportsOffline: view.supportsOffline,
    supportsTorrent: view.supportsTorrent,
    supportsTorrentFile: view.supportsTorrentFile ?? false,
    supportsShareTransfer: view.supportsShareTransfer,
    supportedShareBrands: view.supportedShareBrands,
    offlineSchemes: view.schemes,
  };
}
