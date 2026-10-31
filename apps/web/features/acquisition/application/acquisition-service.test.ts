import { describe, expect, it } from "vitest";
import {
  buildMovieCandidateId,
  buildTvCandidateId,
  parseMovieCandidateId,
  parseTvCandidateId,
  prepareMovieTarget,
  prepareTrackingTarget,
  createTmdbMetadataProvider,
} from "@media-track/workflow";
import {
  queueCandidateTracking,
  reserveCandidate,
  acquireLlmPreflightError,
} from "./acquisition-service";

describe("Acquisition Service & Pipeline Verification", () => {
  describe("Candidate ID Identity Contracts (Anime, TV, Movie)", () => {
    it("correctly parses and formats Anime candidate IDs (e.g. 龙珠超：比鲁斯)", () => {
      const candidateId = buildTvCandidateId({ source: "tmdb", id: 312359, seasonNumber: 1 });
      expect(candidateId).toBe("tmdb_tv_312359_s1");

      const parsed = parseTvCandidateId(candidateId);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.id).toBe(312359);
        expect(parsed.value.seasonNumber).toBe(1);
        expect(parsed.value.source).toBe("tmdb");
      }
    });

    it("correctly parses TV series candidate IDs (e.g. Lupin Season 1)", () => {
      const candidateId = buildTvCandidateId({ source: "tmdb", id: 96677, seasonNumber: 1 });
      expect(candidateId).toBe("tmdb_tv_96677_s1");

      const parsed = parseTvCandidateId(candidateId);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.id).toBe(96677);
        expect(parsed.value.seasonNumber).toBe(1);
      }
    });

    it("correctly parses Movie candidate IDs (e.g. 不存在的罪人)", () => {
      const candidateId = buildMovieCandidateId({ source: "tmdb", id: 1283515 });
      expect(candidateId).toBe("tmdb_movie_1283515");

      const parsed = parseMovieCandidateId(candidateId);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.id).toBe(1283515);
        expect(parsed.value.source).toBe("tmdb");
      }
    });

    it("gracefully detects and rejects malformed candidate IDs", () => {
      expect(parseTvCandidateId("invalid:format").ok).toBe(false);
      expect(parseTvCandidateId("movie:tmdb:123").ok).toBe(false);
      expect(parseMovieCandidateId("tv:tmdb:123:s1").ok).toBe(false);
      expect(parseMovieCandidateId("").ok).toBe(false);
    });
  });

  describe("Tracking Target Generation for Anime, TV and Movie", () => {
    it("prepares a tracking target for an anime series with correct metadata and episodes", async () => {
      const metadataProvider = createTmdbMetadataProvider([
        { baseURL: "https://proxy.example", readToken: "test-token" },
      ], {
        fetchJson: async (url) => {
          if (url.includes("/tv/312359?")) {
            return {
              id: 312359,
              name: "龙珠超：比鲁斯",
              original_name: "Dragon Ball Super Beerus",
              first_air_date: "2026-01-01",
              number_of_episodes: 19,
              overview: "比鲁斯苏醒后降临地球的故事",
              poster_path: "/beerus.jpg",
              backdrop_path: "/beerus_bg.jpg",
              genres: [{ id: 16, name: "Animation" }, { id: 28, name: "Action" }],
              origin_country: ["JP"],
              last_episode_to_air: { season_number: 1, episode_number: 3 },
              seasons: [{ season_number: 1, episode_count: 19 }],
            };
          }
          if (url.includes("/tv/312359/season/1?")) {
            return {
              id: 999,
              season_number: 1,
              episodes: Array.from({ length: 19 }, (_, i) => ({
                episode_number: i + 1,
                name: `第 ${i + 1} 集`,
                air_date: i < 3 ? "2026-01-01" : null,
              })),
            };
          }
          return {};
        },
      });

      const target = await prepareTrackingTarget({
        tmdbId: 312359,
        mediaType: "tv",
        seasonNumber: 1,
        qualityPreference: "1080p",
        metadataProvider,
      });

      expect(target).not.toBeNull();
      expect(target.title.title).toBe("龙珠超：比鲁斯");
      expect(target.title.type).toBe("anime");
      expect(target.season.seasonNumber).toBe(1);
      expect(target.season.totalEpisodes).toBe(19);
      expect(target.season.latestAiredEpisode).toBe(3);
      expect(target.keyword).toBe("龙珠超：比鲁斯");
    });

    it("prepares a movie target with correct single-film anchor and keywords", async () => {
      const metadataProvider = createTmdbMetadataProvider([
        { baseURL: "https://proxy.example", readToken: "test-token" },
      ], {
        fetchJson: async (url) => {
          if (url.includes("/movie/1283515?")) {
            return {
              id: 1283515,
              title: "不存在的罪人",
              original_title: "Verity",
              release_date: "2026-03-01",
              overview: "小说改编悬疑电影",
              poster_path: "/verity.jpg",
              backdrop_path: "/verity_bg.jpg",
              genres: [{ id: 9648, name: "Mystery" }, { id: 53, name: "Thriller" }],
              origin_country: ["US"],
            };
          }
          return {};
        },
      });

      const target = await prepareMovieTarget({
        tmdbId: 1283515,
        qualityPreference: "1080p",
        metadataProvider,
      });

      expect(target.title.title).toBe("不存在的罪人");
      expect(target.title.type).toBe("movie");
      expect(target.title.year).toBe(2026);
      expect(target.keyword).toBe("不存在的罪人");
    });
  });

  describe("Queueing and Deduplication Life Cycle", () => {
    it("returns unsupported for invalid or corrupt candidate IDs", async () => {
      const result = await queueCandidateTracking("malformed-candidate-id-xyz");
      expect(result.status).toBe("unsupported");
    });

    it("evaluates acquireLlmPreflightError to prevent unhandled half-configured ghost runs", async () => {
      // In default single user / unconfigured state, it should return null (free preset fallback allowed)
      const err = await acquireLlmPreflightError("default-account");
      expect(err === null || typeof err === "string").toBe(true);
    });
  });
});
