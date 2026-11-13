import type { ResourceCandidate } from "../domain/domain.js";

/**
 * 115 离线下载（磁力 / ed2k）任务识别与 info_hash 解析。
 *
 * 从 `storage-115-executor.ts` 抽出：该文件在行数棘轮基线上（只降不升），
 * 而这些工具函数与执行器的调用编排无关，是纯字符串/协议处理，单独成模块更好测。
 */

/** 只有 magnet 走离线任务；ed2k 也走离线但 info_hash 不适用。 */
export function isOfflineTaskUrl(url: string): boolean {
  return url.startsWith("magnet:?xt=urn:btih:");
}

export function isOfflineTaskCandidate(candidate: ResourceCandidate): boolean {
  const url = candidate.providerPayload["url"];
  return isOfflineTaskUrl(typeof url === "string" ? url : "");
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decode a 32-char RFC4648 base32 btih into its 40-char lowercase hex form
 *  (160 bits → 20 bytes). Null if any char is outside the alphabet. */
function base32InfoHashToHex(base32: string): string | null {
  let bits = "";
  for (const char of base32.toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) {
      return null;
    }
    bits += index.toString(2).padStart(5, "0");
  }
  let hex = "";
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    hex += parseInt(bits.slice(offset, offset + 8), 2).toString(16).padStart(2, "0");
  }
  return hex;
}

/** The btih info_hash (lowercase hex) from a magnet uri — 115 keys offline tasks
 *  by it, so it is what `task_del` needs to cancel one and `task_lists` to look
 *  one up. Accepts both the 40-char hex and the 32-char base32 btih encodings.
 *  Null only for non-magnet / malformed links. */
export function infoHashFromMagnet(url: string): string | null {
  const match = /xt=urn:btih:([A-Za-z0-9]+)/.exec(url);
  const raw = match?.[1];
  if (!raw) {
    return null;
  }
  if (/^[A-Fa-f0-9]{40}$/.test(raw)) {
    return raw.toLowerCase();
  }
  if (/^[A-Za-z2-7]{32}$/.test(raw)) {
    return base32InfoHashToHex(raw)?.toLowerCase() ?? null;
  }
  return null;
}
