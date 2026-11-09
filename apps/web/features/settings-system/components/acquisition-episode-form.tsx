"use client";

import { useState, useTransition } from "react";
import { Check, Compass, FolderTree, LoaderCircle, RotateCcw } from "lucide-react";
import type { AcquisitionEpisodePolicies, QualityCutoffPreference } from "@media-track/workflow";
import { DEFAULT_EPISODE_POLICIES } from "@media-track/workflow";
import { saveAcquisitionEpisodePoliciesAction } from "../../../app/actions/settings-system-actions";
import { runAction } from "../../../lib/run-action";

const CUTOFF_OPTIONS: Array<{ key: QualityCutoffPreference; label: string }> = [
  { key: "none", label: "不设截止线（始终尝试获取更高画质）" },
  { key: "720p", label: "720p（达标即止）" },
  { key: "1080p", label: "1080p（推荐，达标后锁定，彻底杜绝洗版消耗）" },
  { key: "2160p", label: "4K / 2160p（仅在已有4K时停止洗版）" },
];

export function AcquisitionEpisodeForm({
  initial,
}: {
  initial: AcquisitionEpisodePolicies;
}) {
  const [isPending, startTransition] = useTransition();
  const [directoryInspectionEnabled, setDirectoryInspectionEnabled] = useState(
    initial.directoryInspectionEnabled ?? DEFAULT_EPISODE_POLICIES.directoryInspectionEnabled,
  );
  const [packArbitrationMode, setPackArbitrationMode] = useState<AcquisitionEpisodePolicies["packArbitrationMode"]>(
    initial.packArbitrationMode || DEFAULT_EPISODE_POLICIES.packArbitrationMode,
  );
  const [absoluteEpisodeMappingEnabled, setAbsoluteEpisodeMappingEnabled] = useState(
    initial.absoluteEpisodeMappingEnabled ?? DEFAULT_EPISODE_POLICIES.absoluteEpisodeMappingEnabled,
  );
  const [qualityCutoff, setQualityCutoff] = useState<QualityCutoffPreference>(
    initial.qualityCutoff || DEFAULT_EPISODE_POLICIES.qualityCutoff,
  );
  const [allowAutoUpgrade, setAllowAutoUpgrade] = useState(
    initial.allowAutoUpgrade ?? DEFAULT_EPISODE_POLICIES.allowAutoUpgrade,
  );
  const [result, setResult] = useState<string | null>(null);

  const handleResetDefaults = () => {
    setDirectoryInspectionEnabled(DEFAULT_EPISODE_POLICIES.directoryInspectionEnabled);
    setPackArbitrationMode(DEFAULT_EPISODE_POLICIES.packArbitrationMode);
    setAbsoluteEpisodeMappingEnabled(DEFAULT_EPISODE_POLICIES.absoluteEpisodeMappingEnabled);
    setQualityCutoff(DEFAULT_EPISODE_POLICIES.qualityCutoff);
    setAllowAutoUpgrade(DEFAULT_EPISODE_POLICIES.allowAutoUpgrade);
  };

  const handleSave = () => {
    const payload: AcquisitionEpisodePolicies = {
      directoryInspectionEnabled,
      packArbitrationMode,
      absoluteEpisodeMappingEnabled,
      qualityCutoff,
      allowAutoUpgrade,
    };

    startTransition(async () => {
      const r = await runAction(
        () => saveAcquisitionEpisodePoliciesAction(payload),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 3500);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.success ? "✅ 单集搜索策略与截止线已保存生效" : `❌ ${res.message ?? "保存失败"}`);
      setTimeout(() => setResult(null), 3500);
    });
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: 12 }}>
        配置单集搜索精度、合集大包穿透策略及画质截止线：杜绝为了补 1 集而下载 50GB 大包，避免洗版造成的离线配额浪费。
      </p>

      {/* 网盘合集文件树穿透取件 */}
      <div style={{ marginBottom: 14 }}>
        <label style={{ display: "inline-flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={directoryInspectionEnabled}
            onChange={(e) => setDirectoryInspectionEnabled(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <div>
            <div style={{ fontSize: "0.9rem", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
              <FolderTree size={15} /> 启用网盘合集文件树穿透索引 (Directory Inspection)
            </div>
            <p className="panel-note" style={{ margin: "2px 0 0" }}>
              当搜索命中全季合集分享时，通过云端接口直接读取其文件清单并匹配单集，仅下发目标单集转存，避免转存整季多余文件。
            </p>
          </div>
        </label>
      </div>

      {/* 大包 vs 单集裁决模式 */}
      <div style={{ marginBottom: 14 }}>
        <label htmlFor="pack-arbitration-mode" className="text-xs font-medium text-muted block" style={{ marginBottom: 4 }}>
          大包 vs 单集智能裁决倾斜度
        </label>
        <select
          id="pack-arbitration-mode"
          value={packArbitrationMode}
          onChange={(e) => setPackArbitrationMode(e.target.value as AcquisitionEpisodePolicies["packArbitrationMode"])}
          className="setting-control"
          style={{ width: "100%" }}
        >
          <option value="auto">智能裁决（缺集 &lt; 30% 优先单集；缺集 &ge; 60% 优先大包一次性补全）</option>
          <option value="prefer_single">始终优先单集（严格保护配额与暂存空间）</option>
          <option value="prefer_pack">始终优先整季大包（整季批量入库优先）</option>
        </select>
      </div>

      {/* 番剧绝对集数映射 */}
      <div style={{ marginBottom: 14 }}>
        <label style={{ display: "inline-flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={absoluteEpisodeMappingEnabled}
            onChange={(e) => setAbsoluteEpisodeMappingEnabled(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <div>
            <div style={{ fontSize: "0.9rem", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
              <Compass size={15} /> 连载日漫绝对集数与季偏移双向换算
            </div>
            <p className="panel-note" style={{ margin: "2px 0 0" }}>
              对于《海贼王》《名侦探柯南》等长篇连载番剧，自动换算 Season/Episode 编号与连载总集数（如 S02E05 与 #30），生成双模检索词。
            </p>
          </div>
        </label>
      </div>

      {/* 画质截止线 */}
      <div style={{ marginBottom: 14 }}>
        <label htmlFor="quality-cutoff-select" className="text-xs font-medium text-muted block" style={{ marginBottom: 4 }}>
          画质截止线 (Quality Cutoff)
        </label>
        <select
          id="quality-cutoff-select"
          value={qualityCutoff}
          onChange={(e) => setQualityCutoff(e.target.value as QualityCutoffPreference)}
          className="setting-control"
          style={{ width: "100%" }}
        >
          {CUTOFF_OPTIONS.map((opt) => (
            <option key={opt.key} value={opt.key}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* 允许升级洗版 */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={allowAutoUpgrade}
            onChange={(e) => setAllowAutoUpgrade(e.target.checked)}
          />
          <span style={{ fontSize: "0.85rem" }}>
            允许后台定期巡检自动升级洗版（未达画质截止线时自动替换为更高画质）
          </span>
        </label>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 12 }}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={handleResetDefaults}
          disabled={isPending}
          style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          <RotateCcw size={13} aria-hidden /> 恢复默认策略
        </button>

        <button
          type="button"
          className="primary-button"
          onClick={handleSave}
          disabled={isPending}
        >
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存单集与截止线策略
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
