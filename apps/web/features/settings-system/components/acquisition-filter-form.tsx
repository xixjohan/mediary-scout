"use client";

import { useState, useTransition } from "react";
import { Check, LoaderCircle, RotateCcw, ShieldAlert } from "lucide-react";
import type { AcquisitionFilterPreferences } from "@media-track/workflow";
import { DEFAULT_FILTER_PREFERENCES } from "@media-track/workflow";
import { saveAcquisitionFilterPreferencesAction } from "../../../app/actions/settings-system-actions";
import { runAction } from "../../../lib/run-action";

const ALL_CONTAINERS = [".mkv", ".mp4", ".ts", ".iso", ".mov"] as const;

export function AcquisitionFilterForm({
  initial,
}: {
  initial: AcquisitionFilterPreferences;
}) {
  const [isPending, startTransition] = useTransition();
  const [mode, setMode] = useState<AcquisitionFilterPreferences["mode"]>(initial.mode || "balanced");
  const [keywordsText, setKeywordsText] = useState(
    (initial.negativeKeywords || DEFAULT_FILTER_PREFERENCES.negativeKeywords).join("， "),
  );
  const [containers, setContainers] = useState<string[]>(
    initial.allowedContainers || DEFAULT_FILTER_PREFERENCES.allowedContainers,
  );
  const [movieMinMb, setMovieMinMb] = useState(
    Math.round((initial.minMovieSizeBytes ?? DEFAULT_FILTER_PREFERENCES.minMovieSizeBytes) / (1024 * 1024)),
  );
  const [seriesMinMb, setSeriesMinMb] = useState(
    Math.round((initial.minSeriesEpisodeSizeBytes ?? DEFAULT_FILTER_PREFERENCES.minSeriesEpisodeSizeBytes) / (1024 * 1024)),
  );
  const [animeMinMb, setAnimeMinMb] = useState(
    Math.round((initial.minAnimeEpisodeSizeBytes ?? DEFAULT_FILTER_PREFERENCES.minAnimeEpisodeSizeBytes) / (1024 * 1024)),
  );
  const [result, setResult] = useState<string | null>(null);

  const handleToggleContainer = (ext: string) => {
    setContainers((prev) =>
      prev.includes(ext) ? prev.filter((c) => c !== ext) : [...prev, ext],
    );
  };

  const handleResetDefaults = () => {
    setMode(DEFAULT_FILTER_PREFERENCES.mode);
    setKeywordsText(DEFAULT_FILTER_PREFERENCES.negativeKeywords.join("， "));
    setContainers(DEFAULT_FILTER_PREFERENCES.allowedContainers);
    setMovieMinMb(Math.round(DEFAULT_FILTER_PREFERENCES.minMovieSizeBytes / (1024 * 1024)));
    setSeriesMinMb(Math.round(DEFAULT_FILTER_PREFERENCES.minSeriesEpisodeSizeBytes / (1024 * 1024)));
    setAnimeMinMb(Math.round(DEFAULT_FILTER_PREFERENCES.minAnimeEpisodeSizeBytes / (1024 * 1024)));
  };

  const handleSave = () => {
    const parsedKeywords = keywordsText
      .split(/[,，\n]/)
      .map((k) => k.trim())
      .filter(Boolean);

    const payload: AcquisitionFilterPreferences = {
      mode,
      negativeKeywords: parsedKeywords.length > 0 ? parsedKeywords : DEFAULT_FILTER_PREFERENCES.negativeKeywords,
      allowedContainers: containers.length > 0 ? containers : DEFAULT_FILTER_PREFERENCES.allowedContainers,
      minMovieSizeBytes: Math.max(0, movieMinMb) * 1024 * 1024,
      minSeriesEpisodeSizeBytes: Math.max(0, seriesMinMb) * 1024 * 1024,
      minAnimeEpisodeSizeBytes: Math.max(0, animeMinMb) * 1024 * 1024,
    };

    startTransition(async () => {
      const r = await runAction(
        () => saveAcquisitionFilterPreferencesAction(payload),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 3500);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.success ? "✅ 资源排毒与过滤规则已保存生效" : `❌ ${res.message ?? "保存失败"}`);
      setTimeout(() => setResult(null), 3500);
    });
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: 12 }}>
        配置搜索结果前置排毒规则：自动拦截同名小说、有声书、影视原声带、花絮剪辑及伪装假种压缩包，避免浪费网盘离线配额。
      </p>

      {/* 过滤级别模式 */}
      <div style={{ marginBottom: 14 }}>
        <label className="text-xs font-medium text-muted block" style={{ marginBottom: 6 }}>
          过滤严格度级别
        </label>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[
            { id: "loose", label: "宽松模式" },
            { id: "balanced", label: "平衡模式（推荐）" },
            { id: "strict", label: "严格纯净模式" },
            { id: "custom", label: "自定义模式" },
          ].map((m) => (
            <label key={m.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "0.85rem", cursor: "pointer" }}>
              <input
                type="radio"
                name="filter-mode"
                value={m.id}
                checked={mode === m.id}
                onChange={() => setMode(m.id as AcquisitionFilterPreferences["mode"])}
              />
              {m.label}
            </label>
          ))}
        </div>
      </div>

      {/* 排除关键词黑名单 */}
      <div style={{ marginBottom: 14 }}>
        <label htmlFor="filter-negative-keywords" className="text-xs font-medium text-muted block" style={{ marginBottom: 4 }}>
          排除关键词黑名单（用逗号或换行分隔，命中立即剔除）
        </label>
        <textarea
          id="filter-negative-keywords"
          className="setting-control"
          style={{ width: "100%", minHeight: 64, resize: "vertical", fontFamily: "inherit", fontSize: "0.85rem", padding: "6px 8px" }}
          value={keywordsText}
          onChange={(e) => setKeywordsText(e.target.value)}
          placeholder="例如：原声带, OST, 有声书, 小说, 预告, 花絮, 解说, 枪版, TC, TS"
        />
      </div>

      {/* 允许的媒体容器格式 */}
      <div style={{ marginBottom: 14 }}>
        <label className="text-xs font-medium text-muted block" style={{ marginBottom: 6 }}>
          放行的视频媒体容器（自动剔除 .zip, .rar, .exe, .apk 等诱饵）
        </label>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          {ALL_CONTAINERS.map((ext) => (
            <label key={ext} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "0.85rem", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={containers.includes(ext)}
                onChange={() => handleToggleContainer(ext)}
              />
              <code>{ext}</code>
            </label>
          ))}
        </div>
      </div>

      {/* 体积安全下限闸门 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
        <div>
          <label htmlFor="filter-movie-min-size" className="text-xs font-medium text-muted block" style={{ marginBottom: 4 }}>
            电影正片体积下限 (MB)
          </label>
          <input
            id="filter-movie-min-size"
            type="number"
            min={0}
            step={50}
            className="setting-control"
            style={{ width: "100%" }}
            value={movieMinMb}
            onChange={(e) => setMovieMinMb(Number(e.target.value))}
          />
        </div>
        <div>
          <label htmlFor="filter-series-min-size" className="text-xs font-medium text-muted block" style={{ marginBottom: 4 }}>
            剧集单集体积下限 (MB)
          </label>
          <input
            id="filter-series-min-size"
            type="number"
            min={0}
            step={10}
            className="setting-control"
            style={{ width: "100%" }}
            value={seriesMinMb}
            onChange={(e) => setSeriesMinMb(Number(e.target.value))}
          />
        </div>
        <div>
          <label htmlFor="filter-anime-min-size" className="text-xs font-medium text-muted block" style={{ marginBottom: 4 }}>
            动漫单集体积下限 (MB)
          </label>
          <input
            id="filter-anime-min-size"
            type="number"
            min={0}
            step={10}
            className="setting-control"
            style={{ width: "100%" }}
            value={animeMinMb}
            onChange={(e) => setAnimeMinMb(Number(e.target.value))}
          />
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 12 }}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={handleResetDefaults}
          disabled={isPending}
          style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          <RotateCcw size={13} aria-hidden /> 恢复默认排毒词库
        </button>

        <button
          type="button"
          className="primary-button"
          onClick={handleSave}
          disabled={isPending}
        >
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存过滤规则
        </button>
      </div>

      {result ? (
        <p className="panel-note" style={{ marginTop: 10 }}>
          {result}
        </p>
      ) : null}
    </div>
  );
}
