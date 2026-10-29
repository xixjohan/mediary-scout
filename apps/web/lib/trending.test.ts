import { describe, expect, it } from "vitest";
import {
  animeFirstAirDateFloor,
  buildDiscoverQuery,
  mapTrendingResults,
  TRENDING_KINDS,
  trendingFeedQuery,
} from "./trending";

describe("trending feed contract (must match workers/tmdb-proxy getTrendingFeeds)", () => {
  // The Worker Cron warms KV under cacheKeyFor(path + sorted query). The frontend
  // reads the SAME feed. cacheKeyFor sorts params, so what must match is the param
  // SET, captured here as the sorted querystring. If you edit one side, this fails.
  const sortedQuery = (query: Record<string, string>) =>
    new URLSearchParams([...Object.entries(query)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))).toString();

  it("movie feed = trending/movie/week?language=zh-CN", () => {
    expect(TRENDING_KINDS.movie.path).toBe("trending/movie/week");
    expect(sortedQuery(TRENDING_KINDS.movie.query)).toBe("language=zh-CN");
  });

  it("tv feed = trending/tv/week?language=zh-CN", () => {
    expect(TRENDING_KINDS.tv.path).toBe("trending/tv/week");
    expect(sortedQuery(TRENDING_KINDS.tv.query)).toBe("language=zh-CN");
  });

  it("anime feed = recent (first_air_date rolls to <year-1>-01-01) + mainstream (vote_count.gte=50) + no adult", () => {
    expect(TRENDING_KINDS.anime.path).toBe("discover/tv");
    const now = new Date("2026-07-04T00:00:00Z");
    expect(sortedQuery(trendingFeedQuery("anime", now))).toBe(
      "first_air_date.gte=2025-01-01&include_adult=false&language=zh-CN&sort_by=popularity.desc&vote_count.gte=50&with_genres=16&with_original_language=ja",
    );
  });

  it("movie/tv feed queries carry no dynamic date (unchanged)", () => {
    const now = new Date("2026-07-04T00:00:00Z");
    expect(sortedQuery(trendingFeedQuery("movie", now))).toBe("language=zh-CN");
    expect(sortedQuery(trendingFeedQuery("tv", now))).toBe("language=zh-CN");
  });

  it("anime first-air-date floor rolls with the year (last calendar year onward)", () => {
    expect(animeFirstAirDateFloor(new Date("2026-07-04T00:00:00Z"))).toBe("2025-01-01");
    expect(animeFirstAirDateFloor(new Date("2027-01-01T00:00:00Z"))).toBe("2026-01-01");
  });
});

describe("mapTrendingResults", () => {
  it("maps a movie result (title/release_date/poster_path)", () => {
    const cards = mapTrendingResults(
      { results: [{ id: 27205, title: "盗梦空间", release_date: "2010-07-15", poster_path: "/a.jpg" }] },
      "movie",
    );
    expect(cards).toEqual([
      { tmdbId: 27205, title: "盗梦空间", year: 2010, posterPath: "/a.jpg", mediaType: "movie" },
    ]);
  });

  it("maps a tv/anime result (name/first_air_date) to mediaType tv", () => {
    const cards = mapTrendingResults(
      { results: [{ id: 240411, name: "葬送的芙莉莲", first_air_date: "2023-09-29", poster_path: "/b.jpg" }] },
      "anime",
    );
    expect(cards).toEqual([
      { tmdbId: 240411, title: "葬送的芙莉莲", year: 2023, posterPath: "/b.jpg", mediaType: "tv" },
    ]);
  });

  it("keeps a missing poster_path as null", () => {
    const cards = mapTrendingResults({ results: [{ id: 1, title: "X", release_date: "2020-01-01" }] }, "movie");
    expect(cards[0]!.posterPath).toBeNull();
  });

  it("drops entries with no id or no title, and yields [] on a missing results array", () => {
    expect(mapTrendingResults({ results: [{ title: "no id" }, { id: 2 }] }, "movie")).toEqual([]);
    expect(mapTrendingResults({}, "movie")).toEqual([]);
    expect(mapTrendingResults(null, "movie")).toEqual([]);
  });

  it("null/empty air date → year null", () => {
    const cards = mapTrendingResults({ results: [{ id: 3, title: "Y" }] }, "movie");
    expect(cards[0]!.year).toBeNull();
  });
});

describe("buildDiscoverQuery 动态探索参数构建", () => {
  it("构建电影 2025 年份查询参数", () => {
    const q = buildDiscoverQuery("movie", { year: "2025" });
    expect(q.primary_release_year).toBe("2025");
    expect(q.sort_by).toBe("popularity.desc");
    expect(q.language).toBe("zh-CN");
  });

  it("构建剧集 2020年代 查询参数", () => {
    const q = buildDiscoverQuery("tv", { year: "2020s" });
    expect(q["first_air_date.gte"]).toBe("2020-01-01");
    expect(q["first_air_date.lte"]).toBe("2029-12-31");
  });

  it("正确映射题材 ID（如科幻 with_genres: 878|10765）", () => {
    const q = buildDiscoverQuery("movie", { genre: "scifi" });
    expect(q.with_genres).toBe("878|10765");
  });

  it("支持分页参数（page > 1 时写入 query.page）", () => {
    const q1 = buildDiscoverQuery("movie", { year: "2025", page: 1 });
    expect(q1.page).toBeUndefined();

    const q2 = buildDiscoverQuery("movie", { year: "2025", page: 3 });
    expect(q2.page).toBe("3");
  });

  it("纪录片与综艺精准映射 genre id 与参数", () => {
    const doc = buildDiscoverQuery("movie", { type: "documentary" });
    expect(doc.with_genres).toBe("99");

    const variety = buildDiscoverQuery("tv", { type: "variety" });
    expect(variety.with_genres).toBe("10764|10767");

    const anime = buildDiscoverQuery("tv", { type: "anime" });
    expect(anime.with_genres).toBe("16");
    expect(anime.with_original_language).toBe("ja");
  });

  it("排序维度正确映射到 TMDB Discover 参数", () => {
    const ratingMovie = buildDiscoverQuery("movie", { sort: "rating" });
    expect(ratingMovie.sort_by).toBe("vote_average.desc");
    expect(ratingMovie["vote_count.gte"]).toBe("100");

    const releaseTv = buildDiscoverQuery("tv", { sort: "release" });
    expect(releaseTv.sort_by).toBe("first_air_date.desc");
  });
});
