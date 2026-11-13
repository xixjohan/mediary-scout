/**
 * 影视文件名质量与版本标签适配器 (Filename Quality Adapter)
 *
 * 负责从原始视频文件名中提取分辨率、HDR 格式、视频编码、发版类型与压制版本标签，
 * 生成用户友好的多版本选择标签 (如 "4K HDR · Remux (52.4 GB)", "1080p 高清 · WEB-DL")。
 */

export interface ParsedQualityInfo {
  resolution?: string | undefined; // "2160p" | "1080p" | "720p" | "576p" | "480p"
  hdrType?: string | undefined; // "DV" | "HDR10+" | "HDR10" | "HLG" | "SDR"
  videoCodec?: string | undefined; // "HEVC" | "AVC" | "AV1" | "VC1"
  audioCodec?: string | undefined; // "TrueHD Atmos" | "DTS-HD MA" | "DTS" | "EAC3" | "AAC" | "FLAC"
  sourceType?: string | undefined; // "Remux" | "BluRay" | "WEB-DL" | "HDTV" | "DVDRip"
  edition?: string | undefined; // "IMAX" | "Extended" | "Director's Cut" | "Theatrical"
  displayBadge: string; // 组合标签
}

function detectResolution(clean: string): string | undefined {
  if (/\b(4K|2160P|UHD)\b/.test(clean)) return "2160p";
  if (/\b(1080P|FHD)\b/.test(clean)) return "1080p";
  if (/\b(720P|HD)\b/.test(clean)) return "720p";
  if (/\b(480P|576P|SD)\b/.test(clean)) return "480p";
  return undefined;
}

function detectHdr(clean: string): string | undefined {
  if (/\b(DOVI|DOLBY\s*VISION|DV)\b/.test(clean)) return "DV";
  if (/\b(HDR10\+|HDR10PLUS)\b/.test(clean)) return "HDR10+";
  if (/\b(HDR|HDR10)\b/.test(clean)) return "HDR10";
  if (/\b(HLG)\b/.test(clean)) return "HLG";
  return undefined;
}

function detectVideoCodec(clean: string): string | undefined {
  if (/\b(HEVC|H[\s\.]?265|X265)\b/.test(clean)) return "HEVC";
  if (/\b(AVC|H[\s\.]?264|X264)\b/.test(clean)) return "AVC";
  if (/\b(AV1)\b/.test(clean)) return "AV1";
  if (/\b(VC[\s\.]?1)\b/.test(clean)) return "VC1";
  return undefined;
}

function detectAudioCodec(clean: string): string | undefined {
  if (/\b(ATMOS)\b/.test(clean)) return "Atmos";
  if (/\b(TRUEHD)\b/.test(clean)) return "TrueHD";
  if (/\b(DTS[\s\-]?HD(\s*MA)?)\b/.test(clean)) return "DTS-HD MA";
  if (/\b(DTS)\b/.test(clean)) return "DTS";
  if (/\b(EAC3|DDP|DD\+)\b/.test(clean)) return "EAC3";
  if (/\b(AAC)\b/.test(clean)) return "AAC";
  if (/\b(FLAC)\b/.test(clean)) return "FLAC";
  return undefined;
}

function detectSourceType(clean: string): string | undefined {
  if (/\b(REMUX)\b/.test(clean)) return "Remux";
  if (/\b(BLURAY|BLU[\s\-]?RAY|BD)\b/.test(clean)) return "BluRay";
  if (/\b(WEB[\s\-]?DL|WEBRIP)\b/.test(clean)) return "WEB-DL";
  if (/\b(HDTV)\b/.test(clean)) return "HDTV";
  return undefined;
}

function detectEdition(clean: string): string | undefined {
  if (/\b(IMAX)\b/.test(clean)) return "IMAX";
  if (/\b(EXTENDED)\b/.test(clean)) return "加长版";
  if (/\b(DIRECTOR'?S?\s*CUT|DC)\b/.test(clean)) return "导剪版";
  if (/\b(UNRATED)\b/.test(clean)) return "未分级版";
  return undefined;
}

function formatSizeBadge(sizeBytes: number): string {
  const gb = sizeBytes / (1024 * 1024 * 1024);
  if (gb >= 1) return ` (${gb.toFixed(1)} GB)`;
  const mb = Math.round(sizeBytes / (1024 * 1024));
  return ` (${mb} MB)`;
}

export class FilenameQualityAdapter {
  static parse(fileName: string, sizeBytes?: number): ParsedQualityInfo {
    const clean = fileName.toUpperCase().replace(/[_\.]/g, " ");

    const resolution = detectResolution(clean);
    const hdrType = detectHdr(clean);
    const videoCodec = detectVideoCodec(clean);
    const audioCodec = detectAudioCodec(clean);
    const sourceType = detectSourceType(clean);
    const edition = detectEdition(clean);

    const parts: string[] = [];
    if (resolution === "2160p") parts.push("4K");
    else if (resolution) parts.push(resolution);

    if (hdrType) parts.push(hdrType);
    if (sourceType) parts.push(sourceType);
    if (edition) parts.push(edition);

    let displayBadge = parts.join(" · ") || resolution || "标清";
    if (sizeBytes && sizeBytes > 0) {
      displayBadge += formatSizeBadge(sizeBytes);
    }

    return {
      resolution,
      hdrType,
      videoCodec,
      audioCodec,
      sourceType,
      edition,
      displayBadge,
    };
  }
}
