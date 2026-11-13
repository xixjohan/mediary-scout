"use client";

import { RefreshCw, Settings, CheckSquare, Search, XCircle } from "lucide-react";
import type { MediaLibrary } from "@media-track/contracts";

export interface LibraryToolbarProps {
  currentLibrary: MediaLibrary | null;
  scanning: boolean;
  onTriggerScan: () => void;
  onCancelScan: () => void;
  onOpenSettings: () => void;
  categories: Array<{ id: string; label: string }>;
  viewCategory: string;
  onSelectCategory: (id: string) => void;
  isSelecting: boolean;
  onToggleSelectMode: () => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
}

export function LibraryToolbar({
  currentLibrary,
  scanning,
  onTriggerScan,
  onCancelScan,
  onOpenSettings,
  categories,
  viewCategory,
  onSelectCategory,
  isSelecting,
  onToggleSelectMode,
  searchQuery,
  onSearchChange,
}: LibraryToolbarProps) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: "1rem",
        flexWrap: "wrap",
        marginBottom: "1.25rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", flexWrap: "wrap" }}>
        {currentLibrary && (
          <>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onTriggerScan}
              disabled={scanning}
              style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
            >
              <RefreshCw size={15} className={scanning ? "animate-spin" : ""} />
              {scanning ? "正在智能扫描中..." : "立即扫描库"}
            </button>

            {scanning && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={onCancelScan}
                title="取消当前扫描作业"
                style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.8rem" }}
              >
                <XCircle size={14} /> 取消扫描
              </button>
            )}

            <button
              type="button"
              className="btn btn-secondary"
              onClick={onOpenSettings}
              style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
            >
              <Settings size={15} /> 库设置与路径
            </button>
          </>
        )}

        {/* 动态分类栏：[全部 · 电影 · 文件夹 · 待审核] */}
        <div style={{ display: "flex", background: "rgba(255,255,255,0.05)", borderRadius: "8px", padding: "0.2rem", gap: "0.2rem" }}>
          {categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              className={`btn btn-sm ${viewCategory === cat.id ? "btn-primary" : "btn-secondary"}`}
              onClick={() => onSelectCategory(cat.id)}
              style={{ border: "none", padding: "0.25rem 0.75rem", fontSize: "0.8rem" }}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* 批量多选管理开关按钮 (仅在非文件夹视图下可用) */}
        {viewCategory !== "folder" && (
          <button
            type="button"
            className={`btn btn-sm ${isSelecting ? "btn-primary" : "btn-secondary"}`}
            onClick={onToggleSelectMode}
            style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.8rem" }}
          >
            <CheckSquare size={13} />
            {isSelecting ? "退出多选" : "批量管理"}
          </button>
        )}
      </div>

      {/* 搜索框 (仅在非文件夹视图下显示) */}
      {viewCategory !== "folder" && (
        <div style={{ position: "relative", minWidth: "240px" }}>
          <Search size={15} style={{ position: "absolute", left: "0.75rem", top: "50%", transform: "translateY(-50%)", color: "var(--text-muted, #a1a1aa)" }} />
          <input
            type="text"
            className="input"
            placeholder="搜寻影视标题..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            style={{ width: "100%", paddingLeft: "2.2rem", paddingRight: "0.75rem", paddingTop: "0.45rem", paddingBottom: "0.45rem", fontSize: "0.85rem" }}
          />
        </div>
      )}
    </div>
  );
}
