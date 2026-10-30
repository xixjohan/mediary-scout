import crypto from "node:crypto";
import { normalizePageSize } from "../domain/pagination-window.js";
import type { MediaSource } from "../domain/media-identity.js";
import type { MediaSearchCandidate, MediaSearchProvider } from "../domain/search-view.js";

export const DEFAULT_FRODO_KEY = "0dad551ec0f84ed02907ff5c42e8ec70";
export const DEFAULT_FRODO_SECRET = "bf7dddc7c9cfe6f7";
const TIMEOUT_MS = 3500;

export interface MediaSearchPageResult {
  candidates: MediaSearchCandidate[];
  page: number;
  totalPages: number;
  totalResults: number;
  source: MediaSource;
}

export function signFrodoRequest(
  path: string,
  method = "GET",
  secret = DEFAULT_FRODO_SECRET,
  now = () => Math.floor(Date.now() / 1000),
): { ts: number; sig: string } {
  const ts = now();
  const msg = [method, encodeURIComponent(path), ts].join("&");
  const sig = crypto.createHmac("sha1", secret).update(msg).digest("base64");
  return { ts, sig };
}

export interface DoubanFrodoTarget {
  id?: string | number | undefined;
  title?: string | undefined;
  card_subtitle?: string | undefined;
  year?: string | number | undefined;
  cover_url?: string | undefined;
  rating?: {
    value?: number | undefined;
    count?: number | undefined;
  } | undefined;
}

export interface DoubanFrodoSearchItem {
  layout?: string | undefined;
  target_id?: string | undefined;
  target_type?: string | undefined;
  type_name?: string | undefined;
  target?: DoubanFrodoTarget | undefined;
}

export interface DoubanFrodoSearchResponse {
  total?: number | undefined;
  start?: number | undefined;
  count?: number | undefined;
  items?: DoubanFrodoSearchItem[] | undefined;
}

function parseDoubanId(val: unknown): number {
  if (typeof val === "number" && Number.isSafeInteger(val) && val > 0) return val;
  if (typeof val === "string") {
    const parsed = parseInt(val, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return 100000;
}

function isValidMediaSubject(item: DoubanFrodoSearchItem): boolean {
  if (item.layout && item.layout !== "subject") return false;
  if (!item.target?.title) return false;
  if (item.target_type === "book" || item.type_name === "图书") return false;
  return true;
}

function parseSubjectYear(raw: string | number | undefined): number {
  if (!raw) return 0;
  const parsed = parseInt(String(raw), 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function mapDoubanItemToCandidate(item: DoubanFrodoSearchItem): MediaSearchCandidate | null {
  if (!isValidMediaSubject(item)) return null;
  const title = item.target?.title?.trim();
  if (!title) return null;
  const target = item.target!;

  const id = parseDoubanId(target.id ?? item.target_id);
  const isMovie = item.target_type === "movie" || item.type_name === "电影";
  const mediaType = isMovie ? "movie" : "tv";
  const year = parseSubjectYear(target.year);
  const overview = target.card_subtitle ?? "";
  const posterPath = target.cover_url ?? null;
  const voteAverage = target.rating?.value;

  return {
    tmdbId: id,
    mediaType,
    title,
    originalTitle: title,
    year,
    overview,
    posterPath,
    backdropPath: null,
    source: "douban",
    seasons: isMovie
      ? []
      : [{ seasonNumber: 1, episodeCount: 0, latestAiredEpisode: 0 }],
    ...(voteAverage !== undefined ? { voteAverage } : {}),
  };
}

export class DoubanSearchProvider implements MediaSearchProvider {
  constructor(
    private readonly opts: {
      apiKey?: string | undefined;
      secret?: string | undefined;
      fetchFn?: typeof fetch | undefined;
      timeoutMs?: number | undefined;
    } = {},
  ) {}

  async searchMedia(input: {
    query: string;
    page?: number | undefined;
    pageSize?: number | undefined;
  }): Promise<MediaSearchCandidate[]> {
    const pageResult = await this.searchMediaPage(input);
    return pageResult.candidates;
  }

  async searchMediaPage(input: {
    query: string;
    page?: number | undefined;
    pageSize?: number | undefined;
  }): Promise<MediaSearchPageResult> {
    const query = input.query.trim();
    const page = Math.max(1, input.page ?? 1);
    const count = normalizePageSize(input.pageSize);
    const start = (page - 1) * count;

    if (!query) {
      return { candidates: [], page, totalPages: 1, totalResults: 0, source: "douban" };
    }

    const path = "/api/v2/search/weixin";
    const apiKey = this.opts.apiKey ?? DEFAULT_FRODO_KEY;
    const secret = this.opts.secret ?? DEFAULT_FRODO_SECRET;
    const { ts, sig } = signFrodoRequest(path, "GET", secret);
    const url = `https://frodo.douban.com${path}?q=${encodeURIComponent(query)}&start=${start}&count=${count}&apiKey=${apiKey}&_ts=${ts}&_sig=${encodeURIComponent(sig)}`;

    const fetcher = this.opts.fetchFn ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? TIMEOUT_MS);

    try {
      const res = await fetcher(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "api-client/1 com.douban.frodo/7.18.0(230) Android/30",
        },
      });
      clearTimeout(timer);

      if (!res.ok) {
        return { candidates: [], page, totalPages: 1, totalResults: 0, source: "douban" };
      }

      const json = (await res.json()) as DoubanFrodoSearchResponse;
      const rawItems = json.items ?? [];
      const candidates = rawItems
        .map(mapDoubanItemToCandidate)
        .filter((c): c is MediaSearchCandidate => c !== null);

      const total = typeof json.total === "number" ? json.total : candidates.length;
      const totalPages = Math.max(1, Math.ceil(total / count));

      return {
        candidates,
        page,
        totalPages,
        totalResults: total,
        source: "douban",
      };
    } catch {
      clearTimeout(timer);
      return { candidates: [], page, totalPages: 1, totalResults: 0, source: "douban" };
    }
  }
}

export class FallbackSearchProvider implements MediaSearchProvider {
  constructor(
    private readonly primary: MediaSearchProvider,
    private readonly fallback: MediaSearchProvider,
    private readonly options?: {
      onFallback?: ((query: string, reason: "empty" | "error", error?: unknown) => void) | undefined;
    } | undefined,
  ) {}

  async searchMedia(input: {
    query: string;
    page?: number | undefined;
    pageSize?: number | undefined;
  }): Promise<MediaSearchCandidate[]> {
    const res = await this.searchMediaPage(input);
    return res.candidates;
  }

  async searchMediaPage(input: {
    query: string;
    page?: number | undefined;
    pageSize?: number | undefined;
  }): Promise<MediaSearchPageResult> {
    try {
      const primaryRes = await this.invokeProvider(this.primary, input, "tmdb");
      if (primaryRes.candidates.length > 0) {
        return primaryRes;
      }
      this.options?.onFallback?.(input.query, "empty");
    } catch (error) {
      this.options?.onFallback?.(input.query, "error", error);
    }

    return this.invokeProvider(this.fallback, input, "douban");
  }

  private async invokeProvider(
    provider: MediaSearchProvider,
    input: { query: string; page?: number | undefined; pageSize?: number | undefined },
    defaultSource: MediaSource,
  ): Promise<MediaSearchPageResult> {
    const page = Math.max(1, input.page ?? 1);
    if ("searchMediaPage" in provider && typeof (provider as { searchMediaPage: unknown }).searchMediaPage === "function") {
      return (provider as { searchMediaPage: (i: typeof input) => Promise<MediaSearchPageResult> }).searchMediaPage(input);
    }
    const candidates = await provider.searchMedia(input);
    return {
      candidates,
      page,
      totalPages: 1,
      totalResults: candidates.length,
      source: defaultSource,
    };
  }
}
