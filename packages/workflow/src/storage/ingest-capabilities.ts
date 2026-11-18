/**
 * 网盘 ingest 能力（离线下载 / 分享转存 / 种子上传）的单一真相。
 *
 * 为什么需要这个模块：同一份能力曾经被手写了两遍——服务端
 * `app/api/storage/offline/route.ts` 的 `if (provider === …)` 分发链，和前端
 * `features/storage-drives/core/ingest-protocol-router.ts` 的
 * `DRIVE_INGEST_CAPABILITIES` 字面量。两者没有一致性断言，于是漂移立刻发生：
 * `STORAGE_BRANDS` 注册了 UC 盘，前端表却没有 uc 条目，服务端也没有 uc 转存分支
 * ——用户看着「该网盘不支持转存」的提示，而注册表里它明明是同族品牌。
 *
 * 现在能力只在这里声明一次：`STORAGE_BRANDS` 的每一条都引用本表的条目（必填，
 * 漏填是编译错误），服务端分发读同一份，前端展示也读同一份。
 *
 * 声明与实现的一致性由 storage-registry.test.ts 的「ingest 声明 ↔ 分发分支」
 * 双向断言守住：声明了没实现 = 用户点了必失败；实现了没声明 = 前端把功能藏起来。
 */

import type { ResourceType } from "../domain/domain.js";

export interface IngestCapability {
  provider: string;
  label: string;
  /** 云端离线下载（磁力/ed2k/http/ftp 提交到平台）。 */
  supportsOffline: boolean;
  /** 是否接受 .torrent 种子文件上传。**必须与服务端的消费路径一致**：本仓
   *  目前没有任何品牌消费 torrentBase64，因此全部为 false；把 true 设在这里而
   *  没有实现路径，就是「假功能」（前端 tab 可点、提交必失败）。 */
  supportsTorrentFile: boolean;
  /** 平台是否支持某种轮询接口（仅描述，不参与路由）。 */
  supportsTorrent: boolean;
  /** 分享链接秒级转存。 */
  supportsShareTransfer: boolean;
  /** 该盘可接收哪些品牌的分享链（含自己）。 */
  supportedShareBrands: string[];
  /** 离线提交接受的 URL 协议 scheme（小写，无冒号）。 */
  offlineSchemes: string[];
}

/** 未登记品牌的保守能力：全不支持。调用方无需判空。 */
export const NO_INGEST_CAPABILITY: IngestCapability = {
  provider: "unknown",
  label: "未知网盘",
  supportsOffline: false,
  supportsTorrentFile: false,
  supportsTorrent: false,
  supportsShareTransfer: false,
  supportedShareBrands: [],
  offlineSchemes: [],
};

const OFFLINE_FULL = ["magnet", "http", "https", "ftp", "ed2k"] as const;
const OFFLINE_MAGNET = ["magnet", "ed2k"] as const;

/**
 * 能力表。键与 `StorageProvider` 联合严格对应（storage-registry.test.ts 断言）。
 * 数据来源是各品牌真实的 API 面：
 *  - 115：Cookie 通道有 lixianssp 离线（磁力/ed2k/http/ftp）与 receiveShare；
 *  - 夸克 / UC：同族协议，只有分享转存，没有磁力 web API；
 *  - 123：分享转存 + 原生离线（磁力/ed2k），**不接裸 https**（会偷走分享链）；
 *  - 天翼：只有分享转存；
 *  - 光鸭：分享转存 + 磁力/ed2k 离线（无 http 离线）。
 */
export const INGEST_CAPABILITIES = {
  pan115: {
    provider: "pan115",
    label: "115网盘",
    supportsOffline: true,
    supportsTorrentFile: false,
    supportsTorrent: true,
    supportsShareTransfer: true,
    supportedShareBrands: ["pan115"],
    offlineSchemes: [...OFFLINE_FULL],
  },
  quark: {
    provider: "quark",
    label: "夸克网盘",
    supportsOffline: false,
    supportsTorrentFile: false,
    supportsTorrent: false,
    supportsShareTransfer: true,
    supportedShareBrands: ["quark"],
    offlineSchemes: [],
  },
  uc: {
    provider: "uc",
    label: "UC网盘",
    supportsOffline: false,
    supportsTorrentFile: false,
    supportsTorrent: false,
    supportsShareTransfer: true,
    supportedShareBrands: ["uc"],
    offlineSchemes: [],
  },
  pan123: {
    provider: "pan123",
    label: "123网盘",
    supportsOffline: true,
    supportsTorrentFile: false,
    supportsTorrent: true,
    supportsShareTransfer: true,
    supportedShareBrands: ["pan123"],
    // 123 有 http 离线接口，但编排层刻意不把裸 https 当离线：123 的分享链本身
    // 就是 https，先判离线会把分享链偷走（见 pan123-storage-executor 的注释）。
    offlineSchemes: [...OFFLINE_MAGNET],
  },
  tianyi: {
    provider: "tianyi",
    label: "天翼云盘",
    supportsOffline: false,
    supportsTorrentFile: false,
    supportsTorrent: false,
    supportsShareTransfer: true,
    supportedShareBrands: ["tianyi"],
    offlineSchemes: [],
  },
  guangya: {
    provider: "guangya",
    label: "光鸭云盘",
    supportsOffline: true,
    supportsTorrentFile: false,
    supportsTorrent: false,
    supportsShareTransfer: true,
    supportedShareBrands: ["guangya"],
    offlineSchemes: [...OFFLINE_MAGNET],
  },
} satisfies Record<string, IngestCapability>;

/** 某品牌的能力。未知品牌返回保守的「全不支持」，绝不抛异常（设置页/前端会
 *  带着任意字符串来问）。 */
export function getIngestCapability(provider: string | undefined): IngestCapability {
  if (provider === undefined) return NO_INGEST_CAPABILITY;
  return (INGEST_CAPABILITIES as Record<string, IngestCapability>)[provider] ?? {
    ...NO_INGEST_CAPABILITY,
    provider,
    label: provider,
  };
}

/** 该 URL 是否属于本盘可在离线通道提交的 scheme。纯函数，供服务端路由用。 */
export function isOfflineSchemeAllowed(provider: string | undefined, url: string): boolean {
  const scheme = url.slice(0, url.indexOf(":")).toLowerCase();
  if (!scheme) return false;
  return getIngestCapability(provider).offlineSchemes.includes(scheme);
}

/** 声明了支持种子上传的品牌 —— 目前为空集。测试用它守住「声明 ↔ 实现」。 */
export function brandsSupportingTorrentFile(): string[] {
  return Object.values(INGEST_CAPABILITIES)
    .filter((capability) => capability.supportsTorrentFile)
    .map((capability) => capability.provider);
}


/**
 * 该盘的 ingest 能力。**服务端分发与前端展示的唯一来源**。
 *
 * 注意：这里刻意只读本表，不回读 `STORAGE_BRANDS`——注册表的 `ingest`
 * 字段引用的就是本表的条目（见 storage-registry.test.ts 的「能力表键与注册表
 * 一一对应」断言），回读会成环且没有任何信息增益。
 */
export function ingestCapabilityForBrand(provider: string | undefined): IngestCapability {
  return getIngestCapability(provider);
}

/**
 * Map a brand's resource-provider kinds to the PanSou link types its acquisitions
 * may transfer. A 夸克 drive can only save 夸克 share links; 光鸭 / 123 / 115 take
 * their OWN share links plus magnets (光鸭: restore_share + offline download).
 * Pure + brand-table-driven so the resource assembly stays testable.
 */
export function allowedResourceTypesForKinds(kinds: readonly string[]): ResourceType[] {
  if (kinds.includes("pansou-quark")) {
    return ["quark"];
  }
  if (kinds.includes("pansou-uc")) {
    return ["uc"];
  }
  if (kinds.includes("pansou-tianyi")) {
    return ["tianyi"];
  }
  // 123 share + magnet when prowlarr/pansou-magnet is also listed (dual-path brand).
  if (kinds.includes("pansou-123")) {
    return kinds.includes("prowlarr") || kinds.includes("pansou-magnet")
      ? ["123", "magnet"]
      : ["123"];
  }
  // 光鸭 share + magnet when a magnet source is also listed (dual-path brand).
  if (kinds.includes("pansou-guangya")) {
    return kinds.includes("prowlarr") || kinds.includes("pansou-magnet")
      ? ["guangya", "magnet"]
      : ["guangya"];
  }
  if (kinds.includes("pansou-magnet")) {
    return ["magnet"];
  }
  return ["115", "magnet"];
}
