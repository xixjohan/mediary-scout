"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Play, Edit3, X, Star, Calendar, Film, Check, AlertCircle, HardDrive, Layers, CheckCircle2, Tv } from "lucide-react";
import type { LibraryMediaItem, LibrarySeason, LibraryEpisode, SubtitleTrackInfo } from "@media-track/contracts";
import { MediaryPlayerModal } from "../../player/components/mediary-player-modal";
import { EditMetadataModal } from "./edit-metadata-modal";

export interface SeasonWithEpisodes extends LibrarySeason {
  episodes: LibraryEpisode[];
}

export interface LibraryItemModalProps {
  itemId: string;
  onClose: () => void;
  onRefresh?: () => void;
}

export function LibraryItemModal({ itemId, onClose, onRefresh }: LibraryItemModalProps) {
  const [data, setData] = useState<{ item: LibraryMediaItem; seasons: SeasonWithEpisodes[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedSeasonIndex, setSelectedSeasonIndex] = useState(0);
  const [selectedMovieEpisodeId, setSelectedMovieEpisodeId] = useState<string>("");
  const [editingMetadata, setEditingMetadata] = useState(false);

  // 播放器状态
  const [playingEp, setPlayingEp] = useState<{
    episode: LibraryEpisode;
    streamUrl: string;
    proxyUrl?: string;
    subtitles?: SubtitleTrackInfo[];
    deliveryMode: "redirect" | "proxy";
    deliverySource?: string;
    deliveryReason?: string;
  } | null>(null);

  const [playError, setPlayError] = useState<string | null>(null);
  // 分段加载反馈：解析直链发生在打开播放器之前，用户最容易把这段空白读成「卡死」。
  const [resolvingEpisodeId, setResolvingEpisodeId] = useState<string | null>(null);

  const fetchDetails = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/library/items/${itemId}`);
      if (!res.ok) throw new Error("获取影视详情失败");
      const json = await res.json();
      setData(json);
      if (json.item?.mediaType === "movie" && json.seasons?.[0]?.episodes?.[0]) {
        setSelectedMovieEpisodeId(json.seasons[0].episodes[0].id);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchDetails();
  }, [itemId]);

  const handlePlayEpisode = async (episode: LibraryEpisode) => {
    try {
      setPlayError(null);
      setResolvingEpisodeId(episode.id);
      const res = await fetch(`/api/library/play/${episode.id}`);
      if (!res.ok) throw new Error("获取播放直链失败");
      const json = await res.json();
      setPlayingEp({
        episode,
        streamUrl: json.streamUrl,
        proxyUrl: json.proxyUrl,
        subtitles: json.subtitles,
        deliveryMode: json.deliveryMode || "redirect",
        deliverySource: json.deliverySource,
        deliveryReason: json.deliveryReason,
      });
    } catch (err) {
      setPlayError(`无法播放: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setResolvingEpisodeId(null);
    }
  };

  if (loading || !data) {
    return createPortal(
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.85)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          backdropFilter: "blur(6px)",
        }}
      >
        <div style={{ color: "var(--accent, #22c55e)", fontSize: "1rem" }}>正在加载影视数据...</div>
      </div>,
      document.body
    );
  }

  const { item, seasons } = data;
  const currentSeason = seasons[selectedSeasonIndex] || seasons[0];
  const allEpisodes = seasons.flatMap((s) => s.episodes);

  return (
    <>
      {createPortal(
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.88)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            backdropFilter: "blur(10px)",
            padding: "1rem",
          }}
        >
          <div
            style={{
              background: "var(--bg-surface, #18181b)",
              border: "1px solid var(--border, #333)",
              borderRadius: "16px",
              width: "100%",
              maxWidth: "960px",
              maxHeight: "90vh",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.7)",
            }}
          >
            {/* 头部背景与信息区 */}
            <div
              style={{
                position: "relative",
                padding: "2rem",
                display: "flex",
                gap: "1.75rem",
                borderBottom: "1px solid var(--border-subtle, #27272a)",
                background: item.backdropPath
                  ? `linear-gradient(to bottom, rgba(24, 24, 27, 0.75), rgba(24, 24, 27, 0.98)), url(https://image.tmdb.org/t/p/w1280${item.backdropPath}) center/cover no-repeat`
                  : "linear-gradient(to bottom, rgba(34, 197, 94, 0.08), rgba(24, 24, 27, 0.95))",
              }}
            >
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={onClose}
                style={{ position: "absolute", top: "1rem", right: "1rem", padding: "0.3rem" }}
              >
                <X size={18} />
              </button>

              {/* 海报卡片 */}
              <div
                style={{
                  width: "140px",
                  height: "210px",
                  borderRadius: "10px",
                  overflow: "hidden",
                  flexShrink: 0,
                  background: "#27272a",
                  boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.5)",
                }}
              >
                {item.posterPath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`https://image.tmdb.org/t/p/w500${item.posterPath}`}
                    alt={item.title}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                ) : (
                  <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#71717a" }}>
                    <Film size={36} />
                  </div>
                )}
              </div>

              {/* 核心元数据 */}
              <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
                {playError && (
                  <div style={{ padding: "0.5rem 0.75rem", background: "rgba(239, 68, 68, 0.2)", color: "#ef4444", borderRadius: "6px", marginBottom: "0.75rem", fontSize: "0.85rem" }}>
                    {playError}
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.4rem" }}>
                  <h2 style={{ fontSize: "1.5rem", fontWeight: 700, margin: 0, color: "var(--text, #f4f4f5)" }}>
                    {item.title}
                  </h2>
                  {item.releaseYear && (
                    <span style={{ fontSize: "1.1rem", color: "var(--text-muted, #a1a1aa)" }}>
                      ({item.releaseYear})
                    </span>
                  )}
                  {item.isMetadataLocked && (
                    <span style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem", borderRadius: "4px", background: "rgba(234, 179, 8, 0.2)", color: "#facc15" }}>
                      元数据已锁定
                    </span>
                  )}
                </div>

                {item.originalTitle && item.originalTitle !== item.title && (
                  <div style={{ fontSize: "0.85rem", color: "var(--text-muted, #a1a1aa)", marginBottom: "0.6rem" }}>
                    {item.originalTitle}
                  </div>
                )}

                <div style={{ display: "flex", alignItems: "center", gap: "1rem", fontSize: "0.85rem", color: "var(--text-muted, #a1a1aa)", marginBottom: "0.75rem" }}>
                  {item.rating ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", color: "#fbbf24", fontWeight: 600 }}>
                      <Star size={15} fill="#fbbf24" /> {item.rating.toFixed(1)}
                    </span>
                  ) : null}
                  <span>{item.mediaType === "movie" ? "电影" : `电视剧 · ${seasons.length} 季`}</span>
                  {item.genres.length > 0 && <span>{item.genres.join(" / ")}</span>}
                </div>

                <p
                  style={{
                    fontSize: "0.85rem",
                    color: "var(--text-secondary, #d4d4d8)",
                    lineHeight: 1.5,
                    maxHeight: "4.5rem",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                    margin: 0,
                  }}
                >
                  {item.overview || "暂无简介"}
                </p>

                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginTop: "1rem" }}>
                  {item.mediaType === "movie" && allEpisodes.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={resolvingEpisodeId !== null}
                      onClick={() => {
                        const target = allEpisodes.find((e) => e.id === selectedMovieEpisodeId) || allEpisodes[0];
                        if (target) void handlePlayEpisode(target);
                      }}
                      style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", padding: "0.4rem 1.1rem", fontWeight: 600 }}
                    >
                      <Play size={15} fill="currentColor" />
                      {resolvingEpisodeId !== null ? "正在解析直链…" : "立即播放"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setEditingMetadata(true)}
                    style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
                  >
                    <Edit3 size={14} /> 修改元数据与改名
                  </button>
                </div>
              </div>
            </div>

            {/* 电影多版本选择 / 电视剧季度选择与分集列表 */}
            {item.mediaType === "movie" ? (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", padding: "1.25rem 2rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.85rem" }}>
                  <h3 style={{ fontSize: "0.95rem", fontWeight: 600, margin: 0, color: "var(--text, #f4f4f5)", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    <Layers size={16} /> 可选画质版本 ({allEpisodes.length})
                  </h3>
                  <span style={{ fontSize: "0.8rem", color: "var(--text-muted, #a1a1aa)" }}>
                    可选择不同压制规格与分辨率播放
                  </span>
                </div>

                <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  {allEpisodes.map((ep) => {
                    const isCurrent = selectedMovieEpisodeId === ep.id;
                    const sizeText = ep.sizeBytes / (1024 * 1024 * 1024) >= 1
                      ? `${(ep.sizeBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
                      : `${Math.round(ep.sizeBytes / (1024 * 1024))} MB`;

                    return (
                      <div
                        key={ep.id}
                        onClick={() => setSelectedMovieEpisodeId(ep.id)}
                        style={{
                          background: isCurrent ? "rgba(34, 197, 94, 0.08)" : "rgba(255, 255, 255, 0.03)",
                          border: isCurrent ? "1px solid var(--accent, #22c55e)" : "1px solid var(--border-subtle, #27272a)",
                          borderRadius: "10px",
                          padding: "0.9rem 1.15rem",
                          cursor: "pointer",
                          transition: "all 0.2s ease",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: "1rem",
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.35rem" }}>
                            <span
                              style={{
                                background: isCurrent ? "var(--accent, #22c55e)" : "rgba(255, 255, 255, 0.1)",
                                color: isCurrent ? "#000" : "var(--text, #f4f4f5)",
                                fontWeight: 700,
                                fontSize: "0.75rem",
                                padding: "0.15rem 0.5rem",
                                borderRadius: "4px",
                              }}
                            >
                              {ep.versionTag || ep.resolution || "正片"}
                            </span>
                            <span
                              style={{
                                fontSize: "0.88rem",
                                fontWeight: 600,
                                color: "var(--text, #f4f4f5)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={ep.fileName}
                            >
                              {ep.fileName}
                            </span>
                          </div>

                          <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", fontSize: "0.78rem", color: "var(--text-muted, #a1a1aa)" }}>
                            <span>大小: {sizeText}</span>
                            {ep.videoCodec && <span>编码: {ep.videoCodec}</span>}
                            {ep.resolution && <span>分辨率: {ep.resolution.toUpperCase()}</span>}
                            {ep.subtitles.length > 0 && <span>字幕轨: {ep.subtitles.length} 条</span>}
                          </div>
                        </div>

                        <button
                          type="button"
                          className={`btn btn-sm ${isCurrent ? "btn-primary" : "btn-secondary"}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedMovieEpisodeId(ep.id);
                            void handlePlayEpisode(ep);
                          }}
                          style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", padding: "0.4rem 0.9rem", flexShrink: 0 }}
                        >
                          <Play size={13} fill="currentColor" /> 播放此版本
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", padding: "1.25rem 2rem" }}>
                {seasons.length > 1 && (
                  <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem", overflowX: "auto" }}>
                    {seasons.map((season, idx) => (
                      <button
                        key={season.id}
                        type="button"
                        onClick={() => setSelectedSeasonIndex(idx)}
                        className={`btn btn-sm ${selectedSeasonIndex === idx ? "btn-primary" : "btn-secondary"}`}
                        style={{ borderRadius: "20px", padding: "0.3rem 1rem" }}
                      >
                        {season.name} ({season.episodes.length} 集)
                      </button>
                    ))}
                  </div>
                )}

                {/* 剧集列表网格 */}
                <div style={{ flex: 1, overflowY: "auto", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "0.75rem" }}>
                  {currentSeason?.episodes.map((ep) => (
                    <div
                      key={ep.id}
                      onClick={() => {
                        if (resolvingEpisodeId !== null) return;
                        void handlePlayEpisode(ep);
                      }}
                      style={{
                        background: "rgba(255, 255, 255, 0.03)",
                        border: "1px solid var(--border-subtle, #27272a)",
                        borderRadius: "10px",
                        padding: "0.85rem",
                        cursor: resolvingEpisodeId !== null ? "progress" : "pointer",
                        transition: "all 0.2s ease",
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "space-between",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = "var(--accent, #22c55e)";
                        e.currentTarget.style.background = "rgba(34, 197, 94, 0.05)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = "var(--border-subtle, #27272a)";
                        e.currentTarget.style.background = "rgba(255, 255, 255, 0.03)";
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.4rem" }}>
                        <span
                          style={{
                            background: "var(--accent, #22c55e)",
                            color: "#000",
                            fontWeight: 700,
                            fontSize: "0.75rem",
                            padding: "0.15rem 0.45rem",
                            borderRadius: "4px",
                          }}
                        >
                          E{String(ep.episodeNumber).padStart(2, "0")}
                        </span>
                        <span
                          style={{
                            fontSize: "0.85rem",
                            fontWeight: 600,
                            color: "var(--text, #f4f4f5)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={ep.fileName}
                        >
                          {ep.fileName}
                        </span>
                      </div>

                      {ep.versionTag && (
                        <div style={{ fontSize: "0.72rem", color: "#4ade80", marginBottom: "0.3rem" }}>
                          {ep.versionTag}
                        </div>
                      )}

                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.75rem", color: "var(--text-muted, #a1a1aa)", marginTop: "0.4rem" }}>
                        <span>{(ep.sizeBytes / (1024 * 1024)).toFixed(0)} MB</span>
                        <div style={{ display: "flex", gap: "0.4rem" }}>
                          {ep.resolution && (
                            <span style={{ padding: "0.1rem 0.35rem", borderRadius: "3px", background: "rgba(255,255,255,0.08)", fontSize: "0.7rem" }}>
                              {ep.resolution.toUpperCase()}
                            </span>
                          )}
                          {ep.subtitles.length > 0 && (
                            <span style={{ padding: "0.1rem 0.35rem", borderRadius: "3px", background: "rgba(56, 189, 248, 0.15)", color: "#38bdf8", fontSize: "0.7rem" }}>
                              字幕 {ep.subtitles.length}
                            </span>
                          )}
                          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.2rem", color: "var(--accent, #22c55e)" }}>
                            <Play size={12} fill="currentColor" />
                            {resolvingEpisodeId === ep.id ? "解析直链…" : "播放"}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}

      {/* 增强网盘播放器 */}
      {playingEp && (
        <MediaryPlayerModal
          title={`${item.title} - E${String(playingEp.episode.episodeNumber).padStart(2, "0")}`}
          streamUrl={playingEp.streamUrl}
          proxyUrl={playingEp.proxyUrl}
          subtitles={playingEp.subtitles}
          deliveryMode={playingEp.deliveryMode}
          deliverySource={playingEp.deliverySource}
          deliveryReason={playingEp.deliveryReason}
          onClose={() => setPlayingEp(null)}
        />
      )}

      {/* 修改元数据与重命名弹窗 */}
      {editingMetadata && (
        <EditMetadataModal
          item={item}
          episodes={allEpisodes}
          onClose={() => setEditingMetadata(false)}
          onSaved={() => {
            void fetchDetails();
            onRefresh?.();
          }}
        />
      )}
    </>
  );
}

