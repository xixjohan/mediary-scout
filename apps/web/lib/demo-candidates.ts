import type { MediaSearchCandidate, MediaSearchProvider } from "@media-track/workflow";

export const demoMediaSearchProvider: MediaSearchProvider = {
  async searchMedia(input: { query: string }): Promise<MediaSearchCandidate[]> {
    const query = input.query.toLowerCase();
    return demoCandidates.filter((candidate) => {
      const haystack = [
        candidate.title,
        candidate.originalTitle,
        String(candidate.year),
        candidate.mediaType,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query) || query.includes(candidate.title.toLowerCase());
    });
  },
};

export function findDemoCandidateById(candidateId: string): MediaSearchCandidate | null {
  // Candidate ids may reference ANY season (tmdb_tv_{id}_s{n}); match by tmdbId.
  const tvMatch = /^tmdb_tv_(\d+)_s\d+$/.exec(candidateId);
  if (tvMatch) {
    return findDemoCandidateByTmdbId(Number(tvMatch[1]));
  }
  return demoCandidates.find((candidate) => demoCandidateId(candidate) === candidateId) ?? null;
}

export function findDemoCandidateByTmdbId(tmdbId: number): MediaSearchCandidate | null {
  return demoCandidates.find((candidate) => candidate.tmdbId === tmdbId) ?? null;
}

export function demoCandidateId(candidate: MediaSearchCandidate): string {
  const firstSeason = candidate.seasons[0];
  if (candidate.mediaType === "tv" && firstSeason) {
    return `tmdb_tv_${candidate.tmdbId}_s${firstSeason.seasonNumber}`;
  }
  return `tmdb_${candidate.mediaType}_${candidate.tmdbId}`;
}

export const demoCandidates: MediaSearchCandidate[] = [
  {
    tmdbId: 289271,
    mediaType: "tv",
    title: "翘楚",
    originalTitle: "翘楚",
    year: 2026,
    overview: "一部正在更新的国产剧，当前示例库中已经追踪第 1 季。",
    posterPath: "/vcU56Dw1aKxTTlhrVr0qvPnljDV.jpg",
    backdropPath: "/6CgpC5cS8jvkXgkI0pRoj31nHf6.jpg",
    seasons: [
      {
        seasonNumber: 1,
        episodeCount: 24,
        latestAiredEpisode: 14,
      },
    ],
  },
  {
    tmdbId: 1396,
    mediaType: "tv",
    title: "绝命毒师",
    originalTitle: "Breaking Bad",
    year: 2008,
    overview: "多季完结剧示例，适合后续验证 complete-series package normalization。",
    posterPath: "/rqliuvX7NdknSHu5qaSDfESplQi.jpg",
    backdropPath: "/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg",
    seasons: [
      {
        seasonNumber: 1,
        episodeCount: 7,
        latestAiredEpisode: 7,
      },
      {
        seasonNumber: 2,
        episodeCount: 13,
        latestAiredEpisode: 13,
      },
      {
        seasonNumber: 3,
        episodeCount: 13,
        latestAiredEpisode: 13,
      },
      {
        seasonNumber: 4,
        episodeCount: 13,
        latestAiredEpisode: 13,
      },
      {
        seasonNumber: 5,
        episodeCount: 16,
        latestAiredEpisode: 16,
      },
    ],
  },
  {
    tmdbId: 1311031,
    mediaType: "movie",
    title: "我的僵尸女儿",
    originalTitle: "My Zombie Daughter",
    year: 2025,
    overview: "电影获取示例。产品化后 Type 1 也会留下媒体库记录。",
    posterPath: "/bhIytk0hlaHmGrQFY9P7bWhZZfC.jpg",
    backdropPath: "/1RgPyOhN4DRs225BGTlHJqCudII.jpg",
    seasons: [],
  },
];
