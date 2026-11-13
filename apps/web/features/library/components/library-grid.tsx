"use client";

import { Film, Star, Layers, Lock, Square, CheckSquare, Tv } from "lucide-react";
import type { LibraryMediaItem } from "@media-track/contracts";

export interface LibraryGridProps {
  items: LibraryMediaItem[];
  onSelectItem: (item: LibraryMediaItem) => void;
  loading?: boolean;
  /** 批量多选模式 */
  isSelecting?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
}

interface MediaCardItemProps {
  item: LibraryMediaItem;
  isSelected: boolean;
  isSelecting: boolean;
  onSelectItem: (item: LibraryMediaItem) => void;
  onToggleSelect?: ((id: string) => void) | undefined;
}

function MediaCardItem({
  item,
  isSelected,
  isSelecting,
  onSelectItem,
  onToggleSelect,
}: MediaCardItemProps) {
  return (
    <div
      onClick={() => {
        if (isSelecting && onToggleSelect) {
          onToggleSelect(item.id);
        } else {
          onSelectItem(item);
        }
      }}
      style={{
        position: "relative",
        background: "var(--bg-surface, #1e1e24)",
        border: isSelected ? "2px solid var(--accent, #22c55e)" : "1px solid var(--border-subtle, #27272a)",
        borderRadius: "10px",
        overflow: "hidden",
        cursor: "pointer",
        transition: "transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease",
        display: "flex",
        flexDirection: "column",
        boxShadow: isSelected ? "0 0 12px rgba(34, 197, 94, 0.35)" : "none",
      }}
      onMouseEnter={(e) => {
        if (!isSelected) {
          e.currentTarget.style.transform = "translateY(-4px)";
          e.currentTarget.style.boxShadow = "0 12px 20px -5px rgba(0, 0, 0, 0.5)";
          e.currentTarget.style.borderColor = "var(--accent, #22c55e)";
        }
      }}
      onMouseLeave={(e) => {
        if (!isSelected) {
          e.currentTarget.style.transform = "translateY(0)";
          e.currentTarget.style.boxShadow = "none";
          e.currentTarget.style.borderColor = "var(--border-subtle, #27272a)";
        }
      }}
    >
      {/* 海报封面容器 */}
      <div style={{ position: "relative", width: "100%", aspectRatio: "2 / 3", background: "#18181b" }}>
        {item.posterPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`https://image.tmdb.org/t/p/w500${item.posterPath}`}
            alt={item.title}
            loading="lazy"
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#52525b",
            }}
          >
            <Film size={36} />
          </div>
        )}

        {/* 批量多选勾选框 (左上角浮现) */}
        {isSelecting && (
          <div
            style={{
              position: "absolute",
              top: "0.5rem",
              left: "0.5rem",
              background: isSelected ? "var(--accent, #22c55e)" : "rgba(0, 0, 0, 0.75)",
              color: isSelected ? "#000" : "#fff",
              borderRadius: "6px",
              padding: "0.2rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 2,
              boxShadow: "0 2px 6px rgba(0,0,0,0.5)",
            }}
          >
            {isSelected ? <CheckSquare size={16} /> : <Square size={16} />}
          </div>
        )}

        {/* 评分角标 */}
        {item.rating && item.rating > 0 ? (
          <div
            style={{
              position: "absolute",
              top: "0.5rem",
              right: "0.5rem",
              background: "rgba(0, 0, 0, 0.75)",
              backdropFilter: "blur(4px)",
              padding: "0.15rem 0.45rem",
              borderRadius: "4px",
              fontSize: "0.75rem",
              fontWeight: 600,
              color: "#fbbf24",
              display: "flex",
              alignItems: "center",
              gap: "0.2rem",
            }}
          >
            <Star size={11} fill="#fbbf24" />
            {item.rating.toFixed(1)}
          </div>
        ) : null}

        {/* 锁定标记角标 (非多选模式下在左上角展示) */}
        {!isSelecting && item.isMetadataLocked && (
          <div
            style={{
              position: "absolute",
              top: "0.5rem",
              left: "0.5rem",
              background: "rgba(234, 179, 8, 0.85)",
              padding: "0.15rem 0.35rem",
              borderRadius: "4px",
              fontSize: "0.7rem",
              color: "#000",
              display: "flex",
              alignItems: "center",
            }}
            title="元数据已手动锁定"
          >
            <Lock size={11} />
          </div>
        )}

        {/* 待审核标记 */}
        {item.reviewStatus === "needs_review" && (
          <div
            style={{
              position: "absolute",
              bottom: "0.5rem",
              left: "0.5rem",
              background: "rgba(249, 115, 22, 0.9)",
              padding: "0.15rem 0.45rem",
              borderRadius: "4px",
              fontSize: "0.7rem",
              color: "#fff",
              fontWeight: 600,
            }}
          >
            待审核
          </div>
        )}

        {/* 电影：仅在多清晰度版本 >= 2 时展示版本角标 */}
        {item.mediaType === "movie" && item.versionCount && item.versionCount > 1 ? (
          <div
            style={{
              position: "absolute",
              bottom: "0.5rem",
              right: "0.5rem",
              background: "rgba(34, 197, 94, 0.9)",
              color: "#000",
              fontWeight: 700,
              padding: "0.15rem 0.45rem",
              borderRadius: "4px",
              fontSize: "0.7rem",
              display: "flex",
              alignItems: "center",
              gap: "0.25rem",
              boxShadow: "0 2px 4px rgba(0,0,0,0.4)",
            }}
            title={`拥有 ${item.versionCount} 个不同规格版本`}
          >
            <Layers size={11} />
            <span>{item.versionCount} 版本</span>
          </div>
        ) : null}

        {/* 电视剧/动漫：集数不是版本！严格展示实际集数，仅在存在同集多画质时额外标记多版本 */}
        {item.mediaType === "tv" && item.totalEpisodes && item.totalEpisodes > 0 ? (
          <div
            style={{
              position: "absolute",
              bottom: "0.5rem",
              right: "0.5rem",
              background: item.hasMultiVersion ? "rgba(16, 185, 129, 0.95)" : "rgba(39, 39, 42, 0.9)",
              color: item.hasMultiVersion ? "#000" : "var(--text, #f4f4f5)",
              border: item.hasMultiVersion ? "none" : "1px solid rgba(255, 255, 255, 0.2)",
              fontWeight: 700,
              padding: "0.15rem 0.45rem",
              borderRadius: "4px",
              fontSize: "0.7rem",
              display: "flex",
              alignItems: "center",
              gap: "0.25rem",
              boxShadow: "0 2px 4px rgba(0,0,0,0.4)",
            }}
            title={`共 ${item.totalEpisodes} 集${item.hasMultiVersion ? " · 包含多画质版本" : ""}`}
          >
            <Tv size={11} />
            <span>
              {item.seasonCount && item.seasonCount > 1
                ? `${item.seasonCount} 季 ${item.totalEpisodes} 集`
                : `共 ${item.totalEpisodes} 集`}
              {item.hasMultiVersion ? " · 多版本" : ""}
            </span>
          </div>
        ) : null}
      </div>

      {/* 标题与描述 */}
      <div style={{ padding: "0.75rem 0.85rem", flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
        <div>
          <h4
            style={{
              fontSize: "0.9rem",
              fontWeight: 600,
              margin: "0 0 0.25rem 0",
              color: "var(--text, #f4f4f5)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={item.title}
          >
            {item.title}
          </h4>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.75rem", color: "var(--text-muted, #a1a1aa)" }}>
            <span>{item.releaseYear || "未知年份"}</span>
            <span>{item.mediaType === "movie" ? "电影" : "电视剧"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function LibraryGrid({
  items,
  onSelectItem,
  loading = false,
  isSelecting = false,
  selectedIds,
  onToggleSelect,
}: LibraryGridProps) {
  if (loading) {
    return (
      <div style={{ padding: "4rem", textAlign: "center", color: "var(--text-muted, #a1a1aa)" }}>
        正在加载影视数据...
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div
        style={{
          padding: "4rem 2rem",
          textAlign: "center",
          color: "var(--text-muted, #a1a1aa)",
          background: "rgba(255, 255, 255, 0.02)",
          borderRadius: "10px",
          border: "1px dashed var(--border, #333)",
        }}
      >
        <Film size={40} style={{ margin: "0 auto 1rem auto", opacity: 0.5 }} />
        <h3 style={{ margin: "0 0 0.5rem 0", color: "var(--text, #f4f4f5)" }}>媒体库为空</h3>
        <p style={{ margin: 0, fontSize: "0.9rem" }}>
          请点击右上角「设置」绑定网盘目录并启动扫描，或切换检索分类。
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
        gap: "1.25rem",
      }}
    >
      {items.map((item) => (
        <MediaCardItem
          key={item.id}
          item={item}
          isSelected={selectedIds?.has(item.id) ?? false}
          isSelecting={isSelecting}
          onSelectItem={onSelectItem}
          onToggleSelect={onToggleSelect}
        />
      ))}
    </div>
  );
}
