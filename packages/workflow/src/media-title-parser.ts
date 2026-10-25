/**
 * 确定性媒体文件名解析（任务单 S3.1，P5：大模型误用于正则与文件比对）。
 *
 * 背景：agent 过去靠 LLM 读文件名猜集号/画质——一次 3~8 秒、花 token、且概率性。
 * 本模块是治理文档「90% 确定性规则 + 10% AI 语义裁决」双轨里的规则轨：
 *   1. anitomy         —— 动漫括号名（[字幕组][剧集][集号][分辨率][编码]）
 *   2. parse-torrent-title —— 欧美发行名（Show.S02E05.2160p.WEB-DL）
 *   3. 中文正则层       —— 第N集 / 第N话 / 尝鲜版N / 全N集 / End·完 终章标记
 * 三层合并；判不出的字段留 null，交给（也只交给）上层 AI 裁决。
 *
 * 纯函数、零 IO、微秒级：tests/media-title-parser.test.ts 有性能护栏。
 */
import { Parser as AnitomyParser } from "anitomy";
import { parse as parseTorrentTitle } from "parse-torrent-title";

export interface MediaFileNameParse {
  /** 归一化集号 SxxExx；整包（全N集）与电影为 null */
  episodeCode: string | null;
  season: number | null;
  episode: number | null;
  /** 「全N集」整包的总集数 */
  episodeCount: number | null;
  /** End / 完 / FIN 终章标记 */
  isFinale: boolean;
  /** 1080p / 2160p / 720p … */
  resolution: string | null;
  /** WEB-DL / BluRay / HDTV / Remux … */
  quality: string | null;
  releaseGroup: string | null;
  year: number | null;
  title: string | null;
  /** 集号最终由哪一层提供（排障用） */
  parser: "anitomy" | "ptn" | "chinese" | "none";
}

// anitomy 的 Parser 实例带结果缓存，复用避免重复解析同名文件。
const anitomy = new AnitomyParser();

function toInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function normalizeResolution(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /(\d{3,4})[pP]/.exec(value);
  return m ? `${m[1]}p` : null;
}

function normalizeQuality(...parts: Array<string | null | undefined>): string | null {
  const joined = parts.filter(Boolean).join(" ").toLowerCase();
  if (!joined) return null;
  if (/remux/.test(joined)) return "Remux";
  if (/blu-?ray|蓝光|bdrip/.test(joined)) return "BluRay";
  if (/web-?dl/.test(joined)) return "WEB-DL";
  if (/web-?rip/.test(joined)) return "WEBRip";
  if (/hdtv/.test(joined)) return "HDTV";
  if (/dvdrip/.test(joined)) return "DVDRip";
  return null;
}

/** 中文层：第N集 / 第N话 / 尝鲜版N / 全N集 / 终章标记。 */
function parseChineseLayer(name: string): {
  episode: number | null;
  episodeCount: number | null;
  isFinale: boolean;
  resolution: string | null;
  quality: string | null;
} {
  const episode =
    toInt(/第\s*(\d{1,4})\s*[集话話]/.exec(name)?.[1]) ??
    toInt(/尝鲜版\s*(\d{1,4})/.exec(name)?.[1]) ??
    toInt(/第\s*(\d{1,4})\s*話/.exec(name)?.[1]);
  const episodeCount = toInt(/全\s*(\d{1,4})\s*集/.exec(name)?.[1]);
  // 终章标记：End / FIN / 完 作为独立 token 出现（完 在中文名里常见）
  const isFinale = /(?:^|[\s\-_\[\]【】])(?:End|FIN|完)(?:$|[\s\-_\[\]【】.])/i.test(name);
  return {
    episode,
    episodeCount,
    isFinale,
    resolution: normalizeResolution(name),
    quality: normalizeQuality(name),
  };
}

/**
 * 字幕组兜底：anitomy 对 `[字幕组][剧集][集号]` 常不填 release.group，
 * 而字幕组是去重策略的输入。取首个括号 token，跳过分辨率/语言/编码类 token。
 */
function bracketGroup(name: string): string | null {
  const group = /^\s*\[([^\]]{2,40})\]/.exec(name)?.[1];
  if (!group) return null;
  const token = group.trim();
  if (/^(?:\d{1,4}[pP]|\d{1,4}|CHS|CHT|JP|GB|BIG5|JPSC|AVC|HEVC|x264|x265|10bit|WEB-?DL|BDRIP|Blu-?Ray|Fin|END|完)$/i.test(token)) {
    return null;
  }
  return token;
}

/** 孤立数字兜底：`Show - 05 [1080p]` 这类只有个位/两位集号的名字。 */
function bareEpisodeNumber(name: string): number | null {
  const withoutResolution = name.replace(/\d{3,4}[pP]/g, " ");
  const m = /(?:^|[\s\-_\[\]【（）()])(\d{1,4})(?!\d)(?!p)(?:v\d)?(?:$|[\s\-_\[\]【】（）().])/.exec(
    withoutResolution,
  );
  const value = toInt(m?.[1]);
  // 四位数的孤立数字更像年份/编号，不当集号
  return value !== null && value <= 999 ? value : null;
}

export function parseMediaFileName(fileName: string): MediaFileNameParse {
  const name = fileName.trim();
  const anime = name ? anitomy.parse(name) : undefined;
  const torrent = name ? parseTorrentTitle(name) : undefined;
  const chinese = parseChineseLayer(name);

  // ---- 季 ----
  const season =
    toInt(anime?.season) ??
    (typeof torrent?.season === "number" ? torrent.season : null) ??
    null;

  // ---- 年份先行：电影名里的年份常被 anitomy 误读成集号（Oppenheimer.2023 → E2023）----
  const year =
    anime?.year ?? (typeof torrent?.year === "number" ? torrent.year : null);

  // ---- 集号：中文层优先（中文名最可靠），其后 anitomy、PTN ----
  let episode: number | null = null;
  let parser: MediaFileNameParse["parser"] = "none";
  // 等于年份的"集号"是电影，不是剧集（Movie.2023 模式）。
  const plausibleEpisode = (value: number | null): number | null =>
    value !== null && year !== null && value === year ? null : value;
  if (chinese.episode !== null) {
    episode = plausibleEpisode(chinese.episode);
    parser = "chinese";
  } else if (anime?.episode?.number !== undefined) {
    episode = plausibleEpisode(anime.episode.number);
    parser = "anitomy";
  } else if (typeof torrent?.episode === "number") {
    episode = plausibleEpisode(torrent.episode);
    parser = "ptn";
  } else {
    const bare = plausibleEpisode(bareEpisodeNumber(name));
    if (bare !== null) {
      episode = bare;
      parser = "chinese";
    }
  }

  const effectiveSeason = season ?? (episode !== null ? 1 : null);
  const episodeCode =
    episode !== null && effectiveSeason !== null
      ? `S${String(effectiveSeason).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
      : null;

  // ---- 画质 / 分辨率 / 字幕组 / 年份 ----
  const resolution =
    normalizeResolution(anime?.video?.resolution) ??
    normalizeResolution(torrent?.resolution) ??
    chinese.resolution;
  const quality = normalizeQuality(torrent?.source, torrent?.codec, chinese.quality);
  const releaseGroup = anime?.release?.group ?? torrent?.group ?? bracketGroup(name);
  const title = anime?.title ?? torrent?.title ?? null;

  return {
    episodeCode,
    season: effectiveSeason,
    episode,
    episodeCount: chinese.episodeCount,
    isFinale: chinese.isFinale,
    resolution,
    quality,
    releaseGroup,
    year,
    title: title ?? null,
    parser,
  };
}
