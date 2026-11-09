export interface AcquisitionFilterPreferences {
  mode: "loose" | "balanced" | "strict" | "custom";
  negativeKeywords: string[];
  allowedContainers: string[];
  minMovieSizeBytes: number;
  minSeriesEpisodeSizeBytes: number;
  minAnimeEpisodeSizeBytes: number;
}

export const DEFAULT_FILTER_PREFERENCES: AcquisitionFilterPreferences = {
  mode: "balanced",
  negativeKeywords: [
    "原声带",
    "OST",
    "soundtrack",
    "有声书",
    "有声小说",
    "广播剧",
    "小说",
    "电子书",
    "预告",
    "预告片",
    "trailer",
    "花絮",
    "特辑",
    "采访",
    "解说",
    "剪辑",
    "看点",
    "枪版",
    "抢先版",
    "TC",
    "TS",
    "中字赌博",
    "菠菜",
    "加群领密码",
    "解压密码",
  ],
  allowedContainers: [".mkv", ".mp4", ".ts", ".iso"],
  minMovieSizeBytes: 800 * 1024 * 1024,
  minSeriesEpisodeSizeBytes: 200 * 1024 * 1024,
  minAnimeEpisodeSizeBytes: 100 * 1024 * 1024,
};

export type QualityCutoffPreference = "none" | "720p" | "1080p" | "2160p";

export interface AcquisitionEpisodePolicies {
  directoryInspectionEnabled: boolean;
  packArbitrationMode: "auto" | "prefer_single" | "prefer_pack";
  absoluteEpisodeMappingEnabled: boolean;
  qualityCutoff: QualityCutoffPreference;
  allowAutoUpgrade: boolean;
}

export const DEFAULT_EPISODE_POLICIES: AcquisitionEpisodePolicies = {
  directoryInspectionEnabled: true,
  packArbitrationMode: "auto",
  absoluteEpisodeMappingEnabled: true,
  qualityCutoff: "1080p",
  allowAutoUpgrade: false,
};
