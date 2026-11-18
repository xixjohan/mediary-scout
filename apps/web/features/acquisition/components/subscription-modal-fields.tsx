"use client";

import { HardDrive, Layers, Sliders, Eye } from "lucide-react";
import {
  PRESETS,
  makePriorityGroup,
  type PolicyDraft,
  type PresetKind,
  type SeasonEpisodeRangeDraft,
} from "../core/policy-draft";
import { diagnoseEmptyPreview, type PreviewOutcome, type PreviewProgress } from "../core/policy-preview";
import { PolicyTemplateTools } from "./policy-template-tools";

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

const CONTAIN_CHIPS = ["2160p", "1080p", "简日内嵌", "Remux", "HDR"] as const;
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
  previewProgress,
  previewError,
  onApplyPreset,
  onToggleChip,
  onDraftChange,
  onMustContainChange,
  onMustNotContainChange,
  onSaveAsTemplate,
  seasonNumbers,
}: {
  activePreset: PresetKind;
  draft: PolicyDraft;
  preview: PreviewOutcome | null;
  previewProgress: PreviewProgress | null;
  previewError: string | null;
  onApplyPreset: (preset: PresetKind) => void;
  onToggleChip: (field: "mustContain" | "mustNotContain", chip: string) => void;
  onDraftChange: (patch: Partial<PolicyDraft>) => void;
  onMustContainChange: (value: string) => void;
  onMustNotContainChange: (value: string) => void;
  onSaveAsTemplate: (draft: PolicyDraft) => unknown;
  seasonNumbers?: number[];
}) {
  const diagnosis = preview
    ? diagnoseEmptyPreview({ outcome: preview, hasPriorityGroups: (draft.priorityGroups ?? []).length > 0 })
    : null;
  const isExcludedAll = diagnosis === "rule_excludes_all";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
        <Sliders size={14} aria-hidden />
        画质与资源偏好：
      </label>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {(Object.keys(PRESETS) as PresetKind[]).map((kind) => (
          <button
            key={kind}
            type="button"
            className={`filter-chip ${activePreset === kind ? "is-active" : ""}`}
            onClick={() => onApplyPreset(kind)}
            aria-pressed={activePreset === kind}
            title={PRESETS[kind].description}
            style={{ padding: "3px 8px", fontSize: 12, borderRadius: 6 }}
          >
            {PRESETS[kind].label}
          </button>
        ))}
      </div>

      <PolicyTemplateTools draft={draft} onApply={(loaded) => onDraftChange(loaded)} toPolicy={onSaveAsTemplate} />

      <ChipTermField
        label="必须包含词："
        field="mustContain"
        value={draft.mustContain}
        useRegex={draft.useRegex}
        chips={CONTAIN_CHIPS}
        placeholder="例如：2160p, 1080p（逗号、顿号、空格均可分隔）"
        onToggleChip={onToggleChip}
        onChange={onMustContainChange}
      />

      <SubtitlePreferenceField draft={draft} onDraftChange={onDraftChange} />

      <ChipTermField
        label="必须排除词："
        field="mustNotContain"
        value={draft.mustNotContain}
        useRegex={draft.useRegex}
        chips={EXCLUDE_CHIPS}
        placeholder="例如：CAM/枪版, 预告片"
        tone="danger"
        onToggleChip={onToggleChip}
        onChange={onMustNotContainChange}
      />

      <SeasonEpisodeRangesSection
        seasonNumbers={seasonNumbers ?? []}
        ranges={draft.seasonEpisodeRanges ?? []}
        onChange={(seasonEpisodeRanges) => onDraftChange({ seasonEpisodeRanges })}
      />

      <AdvancedPolicyFields draft={draft} onDraftChange={onDraftChange} />
      <PriorityGroupsSection draft={draft} onDraftChange={onDraftChange} />
      <PreviewStatusCard
        preview={preview}
        previewProgress={previewProgress}
        previewError={previewError}
        diagnosis={diagnosis}
        isExcludedAll={isExcludedAll}
      />
    </div>
  );
}

function EmptyDiagnosisHint({ diagnosis }: { diagnosis: NonNullable<ReturnType<typeof diagnoseEmptyPreview>> }) {
  const copy: Record<typeof diagnosis, string> = {
    source_error: "检索源响应异常，这次「0 命中」不代表没有资源；请稍后重试或让站长检查检索源。",
    unreleased: "该作品尚未上线数字版，公开源通常还没有可转存的高清资源。",
    no_candidates: "本次检索没有拿到任何候选，可以精简搜索词后重试。",
    priority_unmatched: "所有候选都没命中优先级组，被优先级组整体过滤了。",
    wrong_title: "搜到的大多是别的作品，不是这部——换个更完整的片名、加年份或改用原名重搜。",
    rule_excludes_all: "这条规则排除了全部候选——检查一下是不是写得过严。",
  };
  return <span style={{ color: "var(--text-muted)" }}>{copy[diagnosis]}</span>;
}

function chipStyle(active: boolean, activeColor: string, activeBg = "rgba(99,102,241,0.25)"): React.CSSProperties {
  return {
    fontSize: 11,
    cursor: "pointer",
    padding: "1px 5px",
    borderRadius: 3,
    background: active ? activeBg : "rgba(255,255,255,0.05)",
    color: active ? activeColor : "var(--text-muted)",
    border: 0,
    font: "inherit",
  };
}

function splitChipState(value: string, chip: string, useRegex: boolean): boolean {
  const terms = useRegex
    ? value.split(/\r?\n/).map((term) => term.trim())
    : value.split(/[,，、;；\s]+/).map((term) => term.trim());
  return terms.some((term) => term.toLowerCase() === chip.toLowerCase());
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  fontSize: 12,
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(0,0,0,0.2)",
  color: "var(--text-primary)",
};

function createGroup() {
  return makePriorityGroup();
}

export function SeasonEpisodeRangesSection({
  seasonNumbers,
  ranges,
  onChange,
}: {
  seasonNumbers: number[];
  ranges: SeasonEpisodeRangeDraft[];
  onChange: (ranges: SeasonEpisodeRangeDraft[]) => void;
}) {
  const seasons = [...new Set(seasonNumbers.filter((season) => Number.isInteger(season) && season >= 0))].sort((a, b) => a - b);
  if (seasons.length === 0) return null;

  const updateSeason = (
    seasonNumber: number,
    patch: { startEpisode?: number; endEpisode?: number | null },
  ) => {
    const current = ranges.find((item) => item.seasonNumber === seasonNumber);
    const startEpisode = patch.startEpisode ?? current?.startEpisode ?? 1;
    const requestedEnd = patch.endEpisode === undefined ? current?.endEpisode ?? null : patch.endEpisode;
    const endEpisode = requestedEnd === null ? null : Math.max(startEpisode, requestedEnd);
    const next = ranges.filter((item) => item.seasonNumber !== seasonNumber);
    next.push({ seasonNumber, startEpisode, endEpisode });
    onChange(next);
  };

  return (
    <fieldset className="sub-policy-season-ranges">
      <legend>逐季追踪集数</legend>
      <p>起始集默认第 1 集；结束集留空表示持续追踪。此范围与资源集数筛选同时生效。</p>
      {seasons.map((seasonNumber) => {
        const range = ranges.find((item) => item.seasonNumber === seasonNumber);
        const seasonLabel = seasonNumber === 0 ? "特别篇" : `第 ${seasonNumber} 季`;
        return (
          <div className="sub-policy-season-range-row" key={seasonNumber}>
            <strong>{seasonLabel}</strong>
            <label>{seasonLabel}起始集
              <input
                aria-label={`${seasonLabel}起始集`}
                type="number"
                min={1}
                step={1}
                value={range?.startEpisode ?? 1}
                onChange={(event) => updateSeason(seasonNumber, { startEpisode: Math.max(1, Number(event.target.value) || 1) })}
              />
            </label>
            <label>{seasonLabel}结束集
              <input
                aria-label={`${seasonLabel}结束集`}
                type="number"
                min={range?.startEpisode ?? 1}
                step={1}
                placeholder="不限"
                value={range?.endEpisode ?? ""}
                onChange={(event) => updateSeason(seasonNumber, { endEpisode: event.target.value === "" ? null : Math.max(range?.startEpisode ?? 1, Number(event.target.value) || 1) })}
              />
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * 一组「必须包含 / 必须排除」词输入 + 快捷药丸。
 *
 * 两侧共用同一个组件是因为它们的行为必须一致：药丸的选中态与输入框里的词
 * 用同一套切分规则（`splitChipState`），否则全角逗号输入会让药丸显示为未选中。
 */
function ChipTermField({
  label,
  field,
  value,
  useRegex,
  chips,
  placeholder,
  tone = "accent",
  onToggleChip,
  onChange,
}: {
  label: string;
  field: "mustContain" | "mustNotContain";
  value: string;
  useRegex: boolean;
  chips: readonly string[];
  placeholder: string;
  tone?: "accent" | "danger";
  onToggleChip: (field: "mustContain" | "mustNotContain", chip: string) => void;
  onChange: (value: string) => void;
}) {
  const activeColor = tone === "danger" ? "#fb7185" : "#818cf8";
  const activeBg = tone === "danger" ? "rgba(244,63,94,0.2)" : undefined;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{label}</span>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {chips.map((chip) => {
            const active = splitChipState(value, chip, useRegex);
            return (
              <button
                key={chip}
                type="button"
                aria-pressed={active}
                onClick={() => onToggleChip(field, chip)}
                style={chipStyle(active, activeColor, activeBg)}
              >
                +{chip}
              </button>
            );
          })}
        </div>
      </div>
      <input type="text" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} style={inputStyle} />
    </div>
  );
}

/** 字幕偏好：OR 词表 + 「必须带中字」开关（默认软偏好，不排斥无字幕版本）。 */
function SubtitlePreferenceField({
  draft,
  onDraftChange,
}: {
  draft: PolicyDraft;
  onDraftChange: (patch: Partial<PolicyDraft>) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, flexWrap: "wrap" }}>
        <span style={{ color: "var(--text-secondary)" }}>中文字幕：</span>
        <label style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-muted)" }}>
          <input type="checkbox" checked={draft.subtitleRequire} onChange={(event) => onDraftChange({ subtitleRequire: event.target.checked })} />
          必须带中字
        </label>
        <span style={{ color: "var(--text-muted)" }}>
          {draft.subtitleRequire ? "没有字幕标记的候选会被拒绝" : "带字幕的候选优先，但不排除无字幕版本"}
        </span>
      </div>
      <input
        type="text"
        value={draft.subtitleTerms}
        onChange={(event) => onDraftChange({ subtitleTerms: event.target.value })}
        placeholder="简中, CHS, 简繁, 双语, 中字, 内嵌"
        style={inputStyle}
      />
    </div>
  );
}

/** 集数、搜索词、冷却与正则开关（默认折叠）。 */
function AdvancedPolicyFields({
  draft,
  onDraftChange,
}: {
  draft: PolicyDraft;
  onDraftChange: (patch: Partial<PolicyDraft>) => void;
}) {
  return (
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
            value={draft.customKeywords ?? ""}
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
          使用正则匹配包含词和排除词（每行一个表达式）
        </label>
      </div>
      <p className="subscription-policy-help">冷却天数 = 命中一次后 N 天内不再获取新版本（不是失败重试间隔）。</p>
    </details>
  );
}

/** 有序优先级组：从上到下首个命中的组生效；全空组会被跳过。 */
function PriorityGroupsSection({
  draft,
  onDraftChange,
}: {
  draft: PolicyDraft;
  onDraftChange: (patch: Partial<PolicyDraft>) => void;
}) {
  const priorityGroups = draft.priorityGroups ?? [];
  const updateGroup = (index: number, patch: Partial<(typeof priorityGroups)[number]>) =>
    onDraftChange({ priorityGroups: priorityGroups.map((group, i) => (i === index ? { ...group, ...patch } : group)) });
  const move = (index: number, delta: -1 | 1) => {
    const next = [...priorityGroups];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onDraftChange({ priorityGroups: next });
  };
  return (
    <section aria-label="优先级组" className="sub-policy-priority-groups">
      <div className="sub-policy-priority-heading">
        <strong>优先级组</strong>
        <span>从上到下匹配；空白组会跳过，配置优先级组后，未命中任何组的候选会被过滤。</span>
      </div>
      {priorityGroups.map((group, index) => {
        const empty = group.mustContain.trim() === "" && group.mustNotContain.trim() === "";
        return (
          <fieldset key={group.id} className="sub-policy-priority-group">
            <legend>第 {index + 1} 组</legend>
            <label>组名<input value={group.name} maxLength={40} onChange={(event) => updateGroup(index, { name: event.target.value })} /></label>
            <label>必须包含<input value={group.mustContain} placeholder="REMUX, 2160p" onChange={(event) => updateGroup(index, { mustContain: event.target.value })} /></label>
            <label>组内排除<input value={group.mustNotContain} placeholder="杜比视界" onChange={(event) => updateGroup(index, { mustNotContain: event.target.value })} /></label>
            <div className="sub-policy-priority-actions">
              <button type="button" disabled={index === 0} onClick={() => move(index, -1)}>上移</button>
              <button type="button" disabled={index === priorityGroups.length - 1} onClick={() => move(index, 1)}>下移</button>
              <button type="button" onClick={() => onDraftChange({ priorityGroups: priorityGroups.filter((_, i) => i !== index) })}>删除</button>
            </div>
            {empty ? <p style={{ fontSize: 11, color: "var(--text-muted)" }}>空白组会被跳过，不参与匹配</p> : null}
          </fieldset>
        );
      })}
      <button
        type="button"
        disabled={priorityGroups.length >= 8}
        onClick={() => onDraftChange({ priorityGroups: [...priorityGroups, makePriorityGroup()] })}
      >
        添加优先级组
      </button>
    </section>
  );
}

/** 进度 / 结果 / 0 命中诊断（诊断顺序由 core/policy-preview 决定）。 */
function PreviewStatusCard({
  preview,
  previewProgress,
  previewError,
  diagnosis,
  isExcludedAll,
}: {
  preview: PreviewOutcome | null;
  previewProgress: PreviewProgress | null;
  previewError: string | null;
  diagnosis: ReturnType<typeof diagnoseEmptyPreview>;
  isExcludedAll: boolean;
}) {
  if (previewProgress === null && preview === null && previewError === null) return null;
  return (
    <div
      style={{
        padding: "6px 10px",
        borderRadius: 6,
        fontSize: 12,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        background: isExcludedAll ? "rgba(244,63,94,0.1)" : "rgba(99,102,241,0.08)",
        border: "1px solid",
        borderColor: isExcludedAll ? "rgba(244,63,94,0.2)" : "rgba(99,102,241,0.15)",
      }}
      role="status"
      aria-live="polite"
    >
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Eye size={14} aria-hidden />
        {previewProgress !== null ? (
          <span>
            正在检索 {previewProgress.done} / {previewProgress.total || "?"} 个关键词
            {previewProgress.currentKeyword ? `（当前：${previewProgress.currentKeyword}）` : ""}
          </span>
        ) : preview !== null && previewError === null ? (
          <span>
            预计命中 <strong>{preview.matchedCount}</strong> 个资源（共检索 {preview.total} 个，已过滤 {preview.excludedCount} 个
            {preview.matchedWithSubtitleCount > 0 ? `，其中 ${preview.matchedWithSubtitleCount} 个带中文字幕` : ""}
            {preview.cached ? "，缓存结果" : ""}）
          </span>
        ) : null}
      </span>
      {previewError !== null ? <span style={{ color: "var(--text-muted)" }}>{previewError}</span> : null}
      {diagnosis !== null ? <EmptyDiagnosisHint diagnosis={diagnosis} /> : null}
    </div>
  );
}
