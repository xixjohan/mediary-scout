"use client";

import { HardDrive, Layers, Sliders, Eye } from "lucide-react";
import type { PolicyDraft, PreviewOutcome } from "./subscription-policy-panel-model";
import { ruleExcludesEverything } from "./subscription-policy-panel-model";

export interface ConnectedDriveSummary {
  id: string;
  provider: string;
  label?: string | null;
  status: string;
}

export interface SubscriptionSeasonItem {
  seasonNumber: number;
  totalEpisodes?: number;
  name?: string;
}

const CONTAIN_CHIPS = ["2160p", "1080p", "简日内嵌", "简中字幕", "Remux", "HDR"] as const;
const EXCLUDE_CHIPS = ["CAM/枪版", "预告片", "国语配音", "先行版"] as const;

export function StorageSelectorSection({
  drives,
  selectedStorageId,
  onSelectStorageId,
}: {
  drives: ConnectedDriveSummary[];
  selectedStorageId: string;
  onSelectStorageId: (id: string) => void;
}) {
  if (drives.length <= 1) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
        <HardDrive size={14} aria-hidden />
        落盘网盘：
      </label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {drives.map((d) => (
          <button
            key={d.id}
            type="button"
            className={`filter-chip ${selectedStorageId === d.id ? "is-active" : ""}`}
            onClick={() => onSelectStorageId(d.id)}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              fontSize: 12,
              border: "1px solid",
              borderColor: selectedStorageId === d.id ? "#6366f1" : "rgba(255,255,255,0.1)",
              background: selectedStorageId === d.id ? "rgba(99,102,241,0.15)" : "transparent",
              color: selectedStorageId === d.id ? "#818cf8" : "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            {d.label ?? (d.provider === "pan115" ? "115 网盘" : d.provider === "quark" ? "夸克网盘" : "网盘")}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SeasonSelectorSection({
  isTv,
  normalizedSeasons,
  selectedSeasons,
  allSeasonNums,
  excludeSpecial,
  onToggleSeason,
  onSelectAll,
  onSelectLatest,
  onToggleExcludeSpecial,
}: {
  isTv: boolean;
  normalizedSeasons: SubscriptionSeasonItem[];
  selectedSeasons: Set<number>;
  allSeasonNums: number[];
  excludeSpecial: boolean;
  onToggleSeason: (seasonNumber: number) => void;
  onSelectAll: () => void;
  onSelectLatest: () => void;
  onToggleExcludeSpecial: (exclude: boolean) => void;
}) {
  if (!isTv || normalizedSeasons.length <= 1) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <label style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
          <Layers size={14} aria-hidden />
          追踪季范围：
        </label>
        <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
          <button
            type="button"
            style={{ background: "none", border: "none", color: "#818cf8", cursor: "pointer", padding: 0 }}
            onClick={onSelectAll}
          >
            全选
          </button>
          <button
            type="button"
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 0 }}
            onClick={onSelectLatest}
          >
            仅最新季
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {normalizedSeasons.map((s) => {
          const checked = selectedSeasons.has(s.seasonNumber);
          const disabled = s.seasonNumber === 0 && excludeSpecial;
          return (
            <button
              key={s.seasonNumber}
              type="button"
              onClick={() => onToggleSeason(s.seasonNumber)}
              disabled={disabled}
              aria-pressed={checked}
              title={disabled ? "取消排除第 0 季后可选择特典内容" : undefined}
              style={{
                padding: "3px 8px",
                borderRadius: 4,
                fontSize: 12,
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.5 : 1,
                border: "1px solid",
                borderColor: checked ? "#6366f1" : "rgba(255,255,255,0.1)",
                background: checked ? "rgba(99,102,241,0.2)" : "rgba(255,255,255,0.02)",
                color: checked ? "#818cf8" : "var(--text-muted)",
              }}
            >
              第 {s.seasonNumber} 季
            </button>
          );
        })}
      </div>

      {allSeasonNums.includes(0) ? (
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
          <input
            type="checkbox"
            checked={excludeSpecial}
            onChange={(e) => onToggleExcludeSpecial(e.target.checked)}
          />
          自动排除第 0 季 (特典/花絮 SP)
        </label>
      ) : null}
    </div>
  );
}

export function PolicyFilterSection({
  activePreset,
  draft,
  preview,
  previewLoading,
  onApplyPreset,
  onToggleChip,
  onDraftChange,
  onMustContainChange,
  onMustNotContainChange,
}: {
  activePreset: "4k" | "1080p" | "anime" | "custom";
  draft: PolicyDraft;
  preview: PreviewOutcome | null;
  previewLoading: boolean;
  onApplyPreset: (preset: "4k" | "1080p" | "anime" | "custom") => void;
  onToggleChip: (field: "mustContain" | "mustNotContain", chip: string) => void;
  onDraftChange: (patch: Partial<PolicyDraft>) => void;
  onMustContainChange: (value: string) => void;
  onMustNotContainChange: (value: string) => void;
}) {
  const isExcludedAll = preview ? ruleExcludesEverything(preview) : false;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
        <Sliders size={14} aria-hidden />
        画质与资源偏好：
      </label>

      {/* 预设方案切换 */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          type="button"
          className={`filter-chip ${activePreset === "1080p" ? "is-active" : ""}`}
          onClick={() => onApplyPreset("1080p")}
          aria-pressed={activePreset === "1080p"}
          style={{ padding: "3px 8px", fontSize: 12, borderRadius: 6 }}
        >
          1080p 极速内嵌 (推荐)
        </button>
        <button
          type="button"
          className={`filter-chip ${activePreset === "4k" ? "is-active" : ""}`}
          onClick={() => onApplyPreset("4k")}
          aria-pressed={activePreset === "4k"}
          style={{ padding: "3px 8px", fontSize: 12, borderRadius: 6 }}
        >
          4K Remux 原盘
        </button>
        <button
          type="button"
          className={`filter-chip ${activePreset === "anime" ? "is-active" : ""}`}
          onClick={() => onApplyPreset("anime")}
          aria-pressed={activePreset === "anime"}
          style={{ padding: "3px 8px", fontSize: 12, borderRadius: 6 }}
        >
          动漫压制标准
        </button>
        <button
          type="button"
          className={`filter-chip ${activePreset === "custom" ? "is-active" : ""}`}
          onClick={() => onApplyPreset("custom")}
          aria-pressed={activePreset === "custom"}
          style={{ padding: "3px 8px", fontSize: 12, borderRadius: 6 }}
        >
          自定义微调
        </button>
      </div>

      {/* 必须包含 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>必须包含词：</span>
          <div style={{ display: "flex", gap: 4 }}>
            {CONTAIN_CHIPS.map((chip) => (
              <button
                type="button"
                key={chip}
                aria-pressed={draft.mustContain.toLowerCase().includes(chip.toLowerCase())}
                onClick={() => onToggleChip("mustContain", chip)}
                style={{
                  fontSize: 11,
                  cursor: "pointer",
                  padding: "1px 5px",
                  borderRadius: 3,
                  background: draft.mustContain.includes(chip) ? "rgba(99,102,241,0.25)" : "rgba(255,255,255,0.05)",
                  color: draft.mustContain.includes(chip) ? "#818cf8" : "var(--text-muted)",
                  border: 0,
                  font: "inherit",
                }}
              >
                +{chip}
              </button>
            ))}
          </div>
        </div>
        <input
          type="text"
          value={draft.mustContain}
          onChange={(e) => onMustContainChange(e.target.value)}
          placeholder="例如：2160p, 简中字幕（英文逗号隔开）"
          style={{
            width: "100%",
            padding: "6px 10px",
            fontSize: 12,
            borderRadius: 6,
            border: "1px solid rgba(255,255,255,0.1)",
            background: "rgba(0,0,0,0.2)",
            color: "var(--text-primary)",
          }}
        />
      </div>

      {/* 必须排除 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>必须排除词：</span>
          <div style={{ display: "flex", gap: 4 }}>
            {EXCLUDE_CHIPS.map((chip) => (
              <button
                type="button"
                key={chip}
                aria-pressed={draft.mustNotContain.toLowerCase().includes(chip.toLowerCase())}
                onClick={() => onToggleChip("mustNotContain", chip)}
                style={{
                  fontSize: 11,
                  cursor: "pointer",
                  padding: "1px 5px",
                  borderRadius: 3,
                  background: draft.mustNotContain.includes(chip) ? "rgba(244,63,94,0.2)" : "rgba(255,255,255,0.05)",
                  color: draft.mustNotContain.includes(chip) ? "#fb7185" : "var(--text-muted)",
                  border: 0,
                  font: "inherit",
                }}
              >
                +{chip}
              </button>
            ))}
          </div>
        </div>
        <input
          type="text"
          value={draft.mustNotContain}
          onChange={(e) => onMustNotContainChange(e.target.value)}
          placeholder="例如：CAM/枪版, 预告片（英文逗号隔开）"
          style={{
            width: "100%",
            padding: "6px 10px",
            fontSize: 12,
            borderRadius: 6,
            border: "1px solid rgba(255,255,255,0.1)",
            background: "rgba(0,0,0,0.2)",
            color: "var(--text-primary)",
          }}
        />
      </div>

      <details className="subscription-policy-advanced">
        <summary>集数、搜索词与巡检设置</summary>
        <div className="subscription-policy-advanced-fields">
          <label>
            集数范围
            <input
              type="text"
              value={draft.episodeFilter}
              onChange={(event) => onDraftChange({ episodeFilter: event.target.value })}
              placeholder="例如 S01-S03;E01-E10"
            />
          </label>
          <label>
            自定义搜索词
            <input
              type="text"
              value={draft.customKeywords}
              onChange={(event) => onDraftChange({ customKeywords: event.target.value })}
              placeholder="多个词用逗号分隔"
            />
          </label>
          <label>
            巡检冷却天数
            <input
              type="number"
              min={0}
              max={365}
              value={draft.cooldownDays}
              onChange={(event) => onDraftChange({ cooldownDays: Math.min(365, Math.max(0, Number(event.target.value) || 0)) })}
            />
          </label>
          <label className="subscription-policy-regex">
            <input
              type="checkbox"
              checked={draft.useRegex}
              onChange={(event) => onDraftChange({ useRegex: event.target.checked })}
            />
            使用正则匹配包含词和排除词
          </label>
        </div>
        <p className="subscription-policy-help">冷却天数影响自动巡检。搜索词用于扩展资源查询。</p>
      </details>

      {/* 实时规则预览 */}
      {previewLoading || preview ? (
        <div
          style={{
            padding: "6px 10px",
            borderRadius: 6,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: isExcludedAll ? "rgba(244,63,94,0.1)" : "rgba(99,102,241,0.08)",
            border: "1px solid",
            borderColor: isExcludedAll ? "rgba(244,63,94,0.2)" : "rgba(99,102,241,0.15)",
          }}
        >
          <Eye size={14} aria-hidden />
          {previewLoading ? (
            <span>正在检验规则过滤效果...</span>
          ) : preview ? (
            <span>
              预计命中 <strong>{preview.matchedCount}</strong> 个资源（共检索 {preview.total} 个，已过滤 {preview.excludedCount} 个）
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
