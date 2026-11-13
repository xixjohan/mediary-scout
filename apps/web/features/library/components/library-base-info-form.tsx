"use client";

import { useState } from "react";
import { Check, Lock, AlertCircle } from "lucide-react";
import type { MediaLibrary } from "@media-track/contracts";

export interface LibraryBaseInfoFormProps {
  library: MediaLibrary;
  onUpdated: () => void;
}

export function LibraryBaseInfoForm({ library, onUpdated }: LibraryBaseInfoFormProps) {
  const [libName, setLibName] = useState(library.name);
  const [libDelivery, setLibDelivery] = useState(library.defaultDeliveryMode);
  const [savingBase, setSavingBase] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSaveBaseInfo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!libName.trim()) return;
    setSavingBase(true);
    setSaveSuccess(false);
    setSaveError(null);
    try {
      const res = await fetch(`/api/library/${library.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: libName.trim(),
          defaultDeliveryMode: libDelivery,
        }),
      });
      if (res.ok) {
        setSaveSuccess(true);
        onUpdated();
        setTimeout(() => setSaveSuccess(false), 3000);
      } else {
        const json = await res.json().catch(() => null);
        setSaveError(json?.error || "保存失败");
      }
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : "网络请求异常");
    } finally {
      setSavingBase(false);
    }
  };

  const typeDisplay =
    library.libraryType === "movie"
      ? "🎬 电影"
      : library.libraryType === "tv"
        ? "📺 电视剧"
        : library.libraryType === "anime"
          ? "🌸 动漫"
          : "📁 综合/其他";

  return (
    <div
      style={{
        background: "rgba(255, 255, 255, 0.02)",
        border: "1px solid var(--border-subtle, #27272a)",
        borderRadius: "10px",
        padding: "1.2rem",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h3 style={{ fontSize: "0.95rem", fontWeight: 600, margin: 0, color: "var(--text, #f4f4f5)" }}>
          影视库基础信息
        </h3>
        {saveSuccess && (
          <span style={{ fontSize: "0.8rem", color: "#4ade80", display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
            <Check size={14} /> 设置已成功保存
          </span>
        )}
      </div>

      <form onSubmit={(e) => { void handleSaveBaseInfo(e); }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1.1fr 1.5fr auto", gap: "0.85rem", alignItems: "flex-end" }}>
          <div>
            <label style={{ display: "block", fontSize: "0.8rem", color: "var(--text-muted, #a1a1aa)", marginBottom: "0.35rem" }}>
              库名称
            </label>
            <input
              type="text"
              className="input"
              value={libName}
              onChange={(e) => setLibName(e.target.value)}
              placeholder="输入影视库名称"
              required
              style={{ width: "100%", padding: "0.45rem 0.6rem" }}
            />
          </div>

          <div>
            <label style={{ display: "block", fontSize: "0.8rem", color: "var(--text-muted, #a1a1aa)", marginBottom: "0.35rem" }}>
              类型分类
            </label>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.4rem",
                padding: "0.45rem 0.6rem",
                background: "rgba(255,255,255,0.04)",
                borderRadius: "6px",
                border: "1px solid var(--border-subtle, #27272a)",
                color: "var(--text-muted, #a1a1aa)",
                fontSize: "0.85rem",
                cursor: "not-allowed",
              }}
              title="影视库类型创建后已固定，避免元数据拓扑冲突"
            >
              <Lock size={12} />
              <span>{typeDisplay}</span>
            </div>
          </div>

          <div>
            <label style={{ display: "block", fontSize: "0.8rem", color: "var(--text-muted, #a1a1aa)", marginBottom: "0.35rem" }}>
              默认播放投送策略
            </label>
            <select
              className="input"
              value={libDelivery}
              onChange={(e) => setLibDelivery(e.target.value as MediaLibrary["defaultDeliveryMode"])}
              style={{ width: "100%", padding: "0.45rem 0.6rem" }}
            >
              <option value="redirect">302 CDN 直连 (零服务器带宽)</option>
              <option value="proxy">服务器分片代理 (防盗链强)</option>
            </select>
          </div>

          <div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={savingBase}
              style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", padding: "0.45rem 1rem", fontSize: "0.85rem", whiteSpace: "nowrap" }}
            >
              {savingBase ? "保存中..." : "保存设置"}
            </button>
          </div>
        </div>

        {saveError && (
          <div style={{ color: "#ef4444", fontSize: "0.8rem", marginTop: "0.6rem", display: "flex", alignItems: "center", gap: "0.3rem" }}>
            <AlertCircle size={13} /> {saveError}
          </div>
        )}
      </form>
    </div>
  );
}
