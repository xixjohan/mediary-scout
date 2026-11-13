/**
 * AI 智能影视匹配与批量元数据识别服务 (AI Media Matcher)
 *
 * 采用 Prompt-Batching 策略（每批 15 项），调用结构化 LLM 提取纯净片名与检索关键词，
 * 并结合规则责任链与 TMDB 权威库进行双重校准与批量对齐。
 */

import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type {
  BatchRematchItemResult,
  BatchRematchResponse,
  LibraryMediaItem,
} from "@media-track/contracts";
import type { MediaSearchCandidate } from "../domain/search-view.js";
import type { SqliteMediaLibraryRepository } from "../persistence/sqlite/sqlite-media-library.js";
import type { TmdbSearchProvider } from "../providers/tmdb-provider.js";
import { parseTitleWithChain } from "../domain/title-parse-chain.js";

export interface AiMatchTargetItem {
  id: string;
  rawTitle: string;
  sampleFiles?: string[];
  mediaType?: "movie" | "tv";
}

export interface AiMatchOptions {
  model: LanguageModel;
  repo: SqliteMediaLibraryRepository;
  tmdbProvider: TmdbSearchProvider;
  items: AiMatchTargetItem[];
  signal?: AbortSignal;
}

interface ParsedAiResult {
  id: string;
  standardTitle: string;
  originalTitle?: string | undefined;
  year?: number | null | undefined;
  seasonNumber?: number | undefined;
  mediaType?: "movie" | "tv" | undefined;
  suggestedQuery?: string | undefined;
}

const AI_PARSER_SYSTEM_PROMPT = `你是一个专业的影视与动漫元数据解析专家。
从给定的杂乱网盘文件名或文件夹名中，剔除发版组标签、压制参数、字幕组标签、各种杂音，提取出纯净的标准片名、年份、季度编号以及针对 TMDB 检索最有效率的关键词。
输出必须是严格的 JSON 数组，禁止任何 markdown 标签或多余解释文字。
JSON 数组每个元素格式：
{
  "id": "与输入的 id 严格一致",
  "standardTitle": "标准中文片名 (如 奥本海默 或 某科学的超电磁炮T)",
  "originalTitle": "原始片名 (如 Oppenheimer)",
  "year": 2023,
  "seasonNumber": 1,
  "mediaType": "movie 或 tv",
  "suggestedQuery": "最适合在 TMDB 检索的核心关键词 (如 某科学的超电磁炮)"
}`;

async function parseBatchWithAi(
  model: LanguageModel,
  slice: AiMatchTargetItem[],
  signal?: AbortSignal,
): Promise<Map<string, ParsedAiResult>> {
  const aiParsedMap = new Map<string, ParsedAiResult>();
  try {
    const promptItems = slice.map((item) => ({
      id: item.id,
      rawTitle: item.rawTitle,
      sampleFiles: item.sampleFiles?.slice(0, 3) || [],
      mediaType: item.mediaType || "movie",
    }));

    const { text } = await generateText({
      model,
      system: AI_PARSER_SYSTEM_PROMPT,
      prompt: JSON.stringify(promptItems),
      ...(signal ? { abortSignal: signal } : {}),
    });

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as ParsedAiResult[];
      for (const p of parsed) {
        if (p.id) aiParsedMap.set(p.id, p);
      }
    }
  } catch (err) {
    console.warn("[AiMediaMatcher] LLM 批量解析异常，将降级使用规则链匹配:", err);
  }
  return aiParsedMap;
}

function resolveSearchTarget(
  item: AiMatchTargetItem,
  existing: LibraryMediaItem,
  aiInfo?: ParsedAiResult,
): { queryTitle: string; queryYear: number | null | undefined; queryType: "movie" | "tv" } {
  let queryTitle = aiInfo?.suggestedQuery || aiInfo?.standardTitle;
  let queryYear = aiInfo?.year ?? existing.releaseYear;
  const queryType = (aiInfo?.mediaType || existing.mediaType || "movie") as "movie" | "tv";

  if (!queryTitle) {
    const ruleParsed = parseTitleWithChain({ folderName: item.rawTitle });
    if (ruleParsed && ruleParsed.title) {
      queryTitle = ruleParsed.title;
      if (ruleParsed.year) queryYear = ruleParsed.year;
    } else {
      queryTitle = item.rawTitle.replace(/[._\[\]()（）]/g, " ").trim();
    }
  }

  return { queryTitle: queryTitle || item.rawTitle || "Untitled", queryYear, queryType };
}

function pickBestCandidate(
  candidates: MediaSearchCandidate[],
  targetYear?: number | null,
): MediaSearchCandidate | undefined {
  if (candidates.length === 0) return undefined;
  if (!targetYear) return candidates[0];
  return candidates.find((r) => r.year && Math.abs(r.year - targetYear) <= 1) || candidates[0];
}

async function matchSingleMediaItem(
  item: AiMatchTargetItem,
  existing: LibraryMediaItem,
  aiInfo: ParsedAiResult | undefined,
  repo: SqliteMediaLibraryRepository,
  tmdbProvider: TmdbSearchProvider,
): Promise<BatchRematchItemResult> {
  const { queryTitle, queryYear, queryType } = resolveSearchTarget(item, existing, aiInfo);

  try {
    const searchResults = await tmdbProvider.searchMedia({ query: queryTitle });
    const top = pickBestCandidate(searchResults, queryYear);

    if (!top) {
      return {
        id: item.id,
        success: false,
        error: `TMDB 未搜寻到与「${queryTitle}」匹配的影视`,
      };
    }

    const updated = repo.upsertMediaItem({
      ...existing,
      tmdbId: top.tmdbId,
      mediaType: top.mediaType || queryType,
      title: top.title || existing.title,
      originalTitle: top.originalTitle || existing.originalTitle,
      releaseYear: top.year ?? existing.releaseYear,
      overview: top.overview ?? existing.overview,
      posterPath: top.posterPath ?? existing.posterPath,
      backdropPath: top.backdropPath ?? existing.backdropPath,
      rating: top.voteAverage ?? existing.rating,
      genres: existing.genres,
      isMetadataLocked: true,
      reviewStatus: "auto_accepted",
    });

    return {
      id: item.id,
      success: true,
      title: updated.title,
      tmdbId: updated.tmdbId ?? undefined,
    };
  } catch (err: unknown) {
    return {
      id: item.id,
      success: false,
      error: err instanceof Error ? err.message : "匹配失败",
    };
  }
}

export async function matchMediaItemsWithAi(options: AiMatchOptions): Promise<BatchRematchResponse> {
  const { model, repo, tmdbProvider, items, signal } = options;
  if (items.length === 0) {
    return { total: 0, succeeded: 0, failed: 0, results: [] };
  }

  const results: BatchRematchItemResult[] = [];
  const BATCH_SIZE = 15;

  for (let offset = 0; offset < items.length; offset += BATCH_SIZE) {
    if (signal?.aborted) break;

    const slice = items.slice(offset, offset + BATCH_SIZE);
    const aiParsedMap = await parseBatchWithAi(model, slice, signal);

    for (const item of slice) {
      const existing = repo.getMediaItem(item.id);
      if (!existing) {
        results.push({ id: item.id, success: false, error: "条目不存在" });
        continue;
      }

      const matchRes = await matchSingleMediaItem(
        item,
        existing,
        aiParsedMap.get(item.id),
        repo,
        tmdbProvider,
      );
      results.push(matchRes);
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  return {
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}
