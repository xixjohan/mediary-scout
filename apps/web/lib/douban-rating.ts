import { getDurableJsonCache } from "./durable-cache";
import { DEFAULT_FRODO_KEY, signFrodoRequest } from "@media-track/workflow";

/**
 * 豆瓣评分数据源适配器（Douban Rating Adapter）。
 *
 * 核心目标：
 *  1. 为搜索卡片与热门推荐提供高参考价值的华语权威影视口碑（如「豆瓣 8.8」）。
 *  2. 纯 SQLite 持久化多级缓存（7 天 TTL），避免高频重复请求触发豆瓣反爬。
 *  3. 严格优雅降级契约：任何网络超时（2.5s）、反爬拦截（403/captcha）或格式异常
 *     一律返回 null，绝不阻塞搜索页面的主渲染。
 */

export interface DoubanRating {
  score: number;
  voteCount?: number | undefined;
  title?: string | undefined;
  year?: number | undefined;
  doubanId?: string | undefined;
  doubanUrl?: string | undefined;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2500;

function normalizeSearchTitle(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[：:，,。！？!?·•\-_/\\()（）[\]【】]/g, " ")
    .replace(/\s+/g, " ");
}

export function doubanCacheKey(title: string, year?: number | null): string {
  const norm = normalizeSearchTitle(title);
  return `douban:${norm}:${year ?? ""}`;
}

interface DoubanFrodoItem {
  layout?: string;
  target_type?: string;
  type_name?: string;
  target?: {
    id?: string;
    title?: string;
    rating?: {
      value?: number;
      count?: number;
    };
    year?: string | number;
    uri?: string;
  };
}

interface DoubanFrodoResponse {
  items?: DoubanFrodoItem[];
}

export async function fetchDoubanRatingFromUpstream(
  title: string,
  year?: number | null,
): Promise<DoubanRating | null> {
  const query = `${title} ${year ?? ""}`.trim();
  const path = "/api/v2/search/weixin";
  const { ts, sig } = signFrodoRequest(path, "GET");
  const url = `https://frodo.douban.com${path}?q=${encodeURIComponent(query)}&apiKey=${DEFAULT_FRODO_KEY}&_ts=${ts}&_sig=${encodeURIComponent(sig)}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "api-client/1 com.douban.frodo/7.18.0(230) Android/30",
      },
    });
    clearTimeout(timer);

    if (!response.ok) return null;
    const data = (await response.json()) as DoubanFrodoResponse;
    const items = data.items;
    if (!Array.isArray(items) || items.length === 0) return null;

    // 寻找最匹配项：优先标题相同且年份一致或相差 <= 1 年
    const match = items.find((item) => {
      if (item.layout && item.layout !== "subject") return false;
      if (item.target_type === "book" || item.type_name === "图书") return false;
      const t = item.target;
      if (!t || !t.title) return false;
      if (!t.rating || typeof t.rating.value !== "number" || t.rating.value <= 0) return false;
      if (year && t.year) {
        const itemYear = Number(t.year);
        if (Number.isFinite(itemYear) && Math.abs(itemYear - year) > 1) {
          return false;
        }
      }
      return true;
    })?.target;

    if (!match || !match.rating || typeof match.rating.value !== "number" || match.rating.value <= 0) {
      return null;
    }

    const id = match.id ? String(match.id) : undefined;
    const itemYear = match.year ? Number(match.year) : undefined;

    return {
      score: Number(match.rating.value.toFixed(1)),
      voteCount: match.rating.count,
      title: match.title,
      year: Number.isFinite(itemYear) ? itemYear : undefined,
      doubanId: id,
      doubanUrl: id ? `https://movie.douban.com/subject/${id}/` : undefined,
    };
  } catch {
    // 静默降级：网络波动/超时/反爬一律返回 null
    return null;
  }
}

/**
 * 查询单部作品的豆瓣评分（带 7 天持久化 SQLite 缓存）。
 */
export async function getDoubanRating(
  title: string,
  year?: number | null,
): Promise<DoubanRating | null> {
  if (!title.trim()) return null;
  const key = doubanCacheKey(title, year);
  const cache = getDurableJsonCache();

  try {
    const cached = await cache.getJson<DoubanRating>(key);
    if (cached !== null) return cached;
  } catch {
    // 缓存读取失败继续走上游
  }

  const upstream = await fetchDoubanRatingFromUpstream(title, year);
  if (upstream !== null) {
    try {
      await cache.setJson(key, upstream, SEVEN_DAYS_MS);
    } catch {
      // 写入失败忽略
    }
  }
  return upstream;
}

/**
 * 批量并发获取豆瓣评分（Promise.allSettled，带持久化缓存）。
 */
export async function getDoubanRatings(
  items: readonly { title: string; year?: number | null }[],
): Promise<Map<string, DoubanRating>> {
  const result = new Map<string, DoubanRating>();
  if (items.length === 0) return result;

  await Promise.allSettled(
    items.map(async (item) => {
      const mapKey = `${item.title}_${item.year ?? ""}`;
      const rating = await getDoubanRating(item.title, item.year);
      if (rating !== null) {
        result.set(mapKey, rating);
      }
    }),
  );

  return result;
}
