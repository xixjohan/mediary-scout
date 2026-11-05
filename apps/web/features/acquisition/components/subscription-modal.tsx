"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { X, Sparkles, AlertTriangle, Loader2, CheckCircle2 } from "lucide-react";
import { buildMovieCandidateId } from "@media-track/workflow";
import {
  requestTrackingAction,
  requestSeasonAction,
  requestRemainingAction,
} from "../../../app/actions/acquisition-actions";
import {
  draftToPolicy,
  mapPreviewResponse,
  type PolicyDraft,
  type PreviewOutcome,
} from "./subscription-policy-panel-model";
import {
  StorageSelectorSection,
  SeasonSelectorSection,
  PolicyFilterSection,
  type ConnectedDriveSummary,
  type SubscriptionSeasonItem,
} from "./subscription-modal-fields";

export interface SubscriptionModalProps {
  isOpen: boolean;
  onClose: () => void;
  tmdbId: number;
  title: string;
  year: number;
  mediaType: "movie" | "tv" | "anime";
  posterPath?: string | null | undefined;
  initialStorageId?: string | undefined;
  initialTracked?: boolean | undefined;
  seasons?: SubscriptionSeasonItem[] | undefined;
  seasonNumbers?: number[] | undefined;
  onSuccess?: ((result: { status: string; message: string }) => void) | undefined;
}

export function computeEpisodeFilter(
  isTv: boolean,
  selectedSeasons: Set<number>,
  allSeasonNums: number[],
  fallbackFilter: string,
): string {
  if (isTv && selectedSeasons.size > 0 && selectedSeasons.size < allSeasonNums.length) {
    const sorted = Array.from(selectedSeasons).sort((a, b) => a - b);
    return sorted.map((num) => `S${String(num).padStart(2, "0")}`).join(";");
  }
  return fallbackFilter;
}

export async function dispatchImmediateAcquisition({
  tmdbId,
  isTv,
  selectedStorageId,
  selectedSeasons,
}: {
  tmdbId: number;
  isTv: boolean;
  selectedStorageId?: string | undefined;
  selectedSeasons: Set<number>;
}): Promise<{ status: string; message: string }> {
  if (!isTv) {
    return requestTrackingAction({
      candidateId: buildMovieCandidateId({ source: "tmdb", id: tmdbId }),
      currentState: "can_request",
      storageId: selectedStorageId || undefined,
    });
  }
  if (selectedSeasons.size === 1) {
    const singleSeasonNum = Array.from(selectedSeasons)[0]!;
    return requestSeasonAction({
      tmdbId,
      seasonNumber: singleSeasonNum,
      storageId: selectedStorageId || undefined,
    });
  }
  return requestRemainingAction({
    tmdbId,
    storageId: selectedStorageId || undefined,
  });
}

function createPresetDraft(preset: "4k" | "1080p" | "anime" | "custom", draft: PolicyDraft): PolicyDraft {
  if (preset === "4k") {
    return { ...draft, mustContain: "2160p, Remux", mustNotContain: "CAM/枪版, 预告片, 国语配音" };
  }
  if (preset === "1080p") {
    return { ...draft, mustContain: "1080p, 简中字幕", mustNotContain: "CAM/枪版, 预告片" };
  }
  if (preset === "anime") {
    return { ...draft, mustContain: "1080p, 简日内嵌", mustNotContain: "先行版, 枪版" };
  }
  return draft;
}

function toggleChipString(raw: string, chip: string): string {
  const tokens = raw.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean);
  const exists = tokens.some((t) => t.toLowerCase() === chip.toLowerCase());
  const nextTokens = exists ? tokens.filter((t) => t.toLowerCase() !== chip.toLowerCase()) : [...tokens, chip];
  return nextTokens.join(", ");
}

function resolveNormalizedSeasons(
  seasonsProp?: SubscriptionSeasonItem[] | undefined,
  seasonNumbersProp?: number[] | undefined,
): SubscriptionSeasonItem[] {
  if (seasonsProp && seasonsProp.length > 0) return seasonsProp;
  if (seasonNumbersProp && seasonNumbersProp.length > 0) {
    return seasonNumbersProp.map((num) => ({ seasonNumber: num }));
  }
  return [{ seasonNumber: 1 }];
}

function mergeLoadedPolicy(prev: PolicyDraft, policy: Record<string, unknown>): PolicyDraft {
  const mustContain = Array.isArray(policy["mustContain"]) ? policy["mustContain"].join(", ") : prev.mustContain;
  const mustNotContain = Array.isArray(policy["mustNotContain"]) ? policy["mustNotContain"].join(", ") : prev.mustNotContain;
  const rawCustom = policy["customKeywords"];
  const customKeywords = Array.isArray(rawCustom)
    ? rawCustom.join(", ")
    : typeof rawCustom === "string"
      ? rawCustom
      : (prev.customKeywords ?? "");
  return {
    ...prev,
    mustContain,
    mustNotContain,
    customKeywords,
  };
}

export function SubscriptionModal({
  isOpen,
  onClose,
  tmdbId,
  title,
  year,
  mediaType,
  posterPath,
  initialStorageId,
  initialTracked = false,
  seasons: seasonsProp,
  seasonNumbers: seasonNumbersProp,
  onSuccess,
}: SubscriptionModalProps) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);

  // 1. 目标网盘
  const [drives, setDrives] = useState<ConnectedDriveSummary[]>([]);
  const [selectedStorageId, setSelectedStorageId] = useState<string>(initialStorageId ?? "");

  // 2. 季集选择 (TV/Anime)
  const isTv = mediaType !== "movie";
  const normalizedSeasons = resolveNormalizedSeasons(seasonsProp, seasonNumbersProp);
  const allSeasonNums = normalizedSeasons.map((s) => s.seasonNumber);
  const [selectedSeasons, setSelectedSeasons] = useState<Set<number>>(new Set(allSeasonNums));
  const [excludeSpecial, setExcludeSpecial] = useState(true);

  // 3. 画质过滤与偏好
  const [activePreset, setActivePreset] = useState<"4k" | "1080p" | "anime" | "custom">("1080p");
  const [draft, setDraft] = useState<PolicyDraft>({
    mustContain: "1080p, 简中字幕",
    mustNotContain: "CAM/枪版, 预告片",
    episodeFilter: "",
    useRegex: false,
    cooldownDays: 0,
    customKeywords: "",
  });

  // 4. 预览与提交状态
  const [preview, setPreview] = useState<PreviewOutcome | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [immediateAcquire, setImmediateAcquire] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // 挂载时拉取可用网盘列表与已存策略
  useEffect(() => {
    if (!isOpen) return;

    fetch("/api/storage/drives")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { drives?: ConnectedDriveSummary[] } | null) => {
        if (data?.drives && data.drives.length > 0) {
          setDrives(data.drives);
          if (!selectedStorageId) {
            setSelectedStorageId(initialStorageId ?? data.drives[0]!.id);
          }
        }
      })
      .catch(() => {});

    if (initialTracked) {
      fetch(`/api/titles/subscription-policy?tmdbId=${tmdbId}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { policy?: Record<string, unknown> } | null) => {
          if (data?.policy) {
            setDraft((prev) => mergeLoadedPolicy(prev, data.policy as Record<string, unknown>));
            setActivePreset("custom");
          }
        })
        .catch(() => {});
    }
  }, [isOpen, tmdbId, initialStorageId, selectedStorageId, initialTracked]);

  // 防抖预览规则匹配效果
  const previewTimerRef = useRef<NodeJS.Timeout | null>(null);
  const triggerPreview = useCallback((currentDraft: PolicyDraft) => {
    if (!initialTracked) return;
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(() => {
      void (async () => {
        setPreviewLoading(true);
        try {
          const policyPayload = draftToPolicy(currentDraft);
          const res = await fetch("/api/titles/subscription-policy/preview", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              tmdbId,
              policy: policyPayload,
            }),
          });
          const body: unknown = await res.json().catch(() => null);
          const mapped = mapPreviewResponse(res.status, body);
          if (mapped.kind === "previewed") {
            setPreview(mapped.outcome);
          }
        } catch {
          // best effort preview
        } finally {
          setPreviewLoading(false);
        }
      })();
    }, 350);
  }, [tmdbId, initialTracked]);

  const applyPreset = (preset: "4k" | "1080p" | "anime" | "custom") => {
    setActivePreset(preset);
    const next = createPresetDraft(preset, draft);
    setDraft(next);
    triggerPreview(next);
  };

  const toggleChip = (field: "mustContain" | "mustNotContain", chip: string) => {
    const nextDraft = { ...draft, [field]: toggleChipString(draft[field], chip) };
    setDraft(nextDraft);
    setActivePreset("custom");
    triggerPreview(nextDraft);
  };

  const handleToggleSeason = (seasonNumber: number) => {
    const next = new Set(selectedSeasons);
    if (next.has(seasonNumber)) {
      if (next.size > 1) next.delete(seasonNumber);
    } else {
      next.add(seasonNumber);
    }
    setSelectedSeasons(next);
  };

  // 提交并启动订阅/获取工作流
  const handleSubmit = async () => {
    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const calculatedEpisodeFilter = computeEpisodeFilter(isTv, selectedSeasons, allSeasonNums, draft.episodeFilter);

      let actionResult = { status: "requested", message: "订阅已创建并加入后台队列。" };
      if (immediateAcquire) {
        const res = await dispatchImmediateAcquisition({
          tmdbId,
          isTv,
          selectedStorageId,
          selectedSeasons,
        });
        if (res.status === "unsupported" || res.status === "llm_not_configured") {
          setErrorMsg(res.message);
          setIsSubmitting(false);
          return;
        }
        actionResult = res;
      }

      const policyPayload = draftToPolicy({
        ...draft,
        episodeFilter: calculatedEpisodeFilter,
      });

      if (initialTracked) {
        await fetch("/api/titles/subscription-policy", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tmdbId,
            mediaType,
            policy: policyPayload,
          }),
        });
      }

      onSuccess?.(actionResult);
      onClose();
      router.refresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "提交订阅配置失败");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen || !mounted) return null;

  return createPortal(
    <div
      className="acquiring-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{ zIndex: 9999 }}
    >
      <div
        className="acquiring-modal"
        style={{ maxWidth: 540 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="acquiring-modal-header">
          <h2>
            <Sparkles size={16} aria-hidden style={{ color: "#6366f1" }} />
            配置订阅与入库策略
          </h2>
          <button
            type="button"
            className="acquiring-modal-close"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className="acquiring-modal-body" style={{ gap: 16 }}>
          <div className="acquiring-title-summary" style={{ padding: "8px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 8 }}>
            {posterPath ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={posterPath.startsWith("http") ? posterPath : `https://image.tmdb.org/t/p/w185${posterPath}`}
                alt=""
                className="acquiring-modal-poster"
              />
            ) : (
              <span className="acquiring-modal-poster-fallback">{title.slice(0, 4)}</span>
            )}
            <div className="acquiring-title-meta">
              <h3 style={{ fontSize: 15, margin: "0 0 4px" }}>{title}</h3>
              <div className="acquiring-meta-chips" style={{ fontSize: 12 }}>
                <span>{year}</span>
                <span>·</span>
                <span>{isTv ? "剧集" : "电影"}</span>
                {isTv && normalizedSeasons.length > 0 ? (
                  <>
                    <span>·</span>
                    <span>共 {normalizedSeasons.length} 季</span>
                  </>
                ) : null}
              </div>
            </div>
          </div>

          <StorageSelectorSection
            drives={drives}
            selectedStorageId={selectedStorageId}
            onSelectStorageId={setSelectedStorageId}
          />

          <SeasonSelectorSection
            isTv={isTv}
            normalizedSeasons={normalizedSeasons}
            selectedSeasons={selectedSeasons}
            allSeasonNums={allSeasonNums}
            excludeSpecial={excludeSpecial}
            onToggleSeason={handleToggleSeason}
            onSelectAll={() => setSelectedSeasons(new Set(allSeasonNums))}
            onSelectLatest={() => setSelectedSeasons(new Set([allSeasonNums[allSeasonNums.length - 1]!]))}
            onToggleExcludeSpecial={setExcludeSpecial}
          />

          <PolicyFilterSection
            activePreset={activePreset}
            draft={draft}
            preview={preview}
            previewLoading={previewLoading}
            onApplyPreset={applyPreset}
            onToggleChip={toggleChip}
            onMustContainChange={(val) => {
              setDraft((prev) => ({ ...prev, mustContain: val }));
              setActivePreset("custom");
              triggerPreview({ ...draft, mustContain: val });
            }}
            onMustNotContainChange={(val) => {
              setDraft((prev) => ({ ...prev, mustNotContain: val }));
              setActivePreset("custom");
              triggerPreview({ ...draft, mustNotContain: val });
            }}
          />

          <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 10 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={immediateAcquire}
                onChange={(e) => setImmediateAcquire(e.target.checked)}
              />
              保存配置后立即启动首次检索与入库工作流
            </label>
          </div>

          {errorMsg ? (
            <p style={{ color: "#f87171", fontSize: 12, margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
              <AlertTriangle size={14} aria-hidden />
              {errorMsg}
            </p>
          ) : null}
        </div>

        <div className="acquiring-modal-footer">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={isSubmitting}
            style={{ padding: "6px 14px", fontSize: 13 }}
          >
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => void handleSubmit()}
            disabled={isSubmitting}
            style={{ padding: "6px 18px", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}
          >
            {isSubmitting ? (
              <Loader2 size={14} className="spin" aria-hidden />
            ) : (
              <CheckCircle2 size={14} aria-hidden />
            )}
            {isSubmitting ? "正在初始化..." : "确认并开始订阅"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
