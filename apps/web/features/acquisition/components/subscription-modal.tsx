"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { buildMovieCandidateId } from "@media-track/workflow";
import {
  requestTrackingAction,
  requestSelectedSeasonsAction,
} from "../../../app/actions/acquisition-actions";
import {
  draftToPolicy,
  mapSavedPolicy,
  mapPreviewResponse,
  type PolicyDraft,
  type PreviewOutcome,
} from "./subscription-policy-panel-model";
import { savePolicyBeforeAcquisition } from "./subscription-modal-flow";
import {
  type ConnectedDriveSummary,
  type SubscriptionSeasonItem,
} from "./subscription-modal-fields";
import { SubscriptionModalView } from "./subscription-modal-view";

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
  _isTv: boolean,
  _selectedSeasons: Set<number>,
  _allSeasonNums: number[],
  fallbackFilter: string,
): string {
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
  return requestSelectedSeasonsAction({
    tmdbId,
    seasonNumbers: Array.from(selectedSeasons).sort((a, b) => a - b),
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
  const loaded = mapSavedPolicy(policy);
  if (!loaded) return prev;
  return {
    ...prev,
    ...loaded,
    customKeywords: loaded.customKeywords ?? "",
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
  const shouldQueueAcquisition = !initialTracked || isTv;
  const normalizedSeasons = resolveNormalizedSeasons(seasonsProp, seasonNumbersProp);
  const allSeasonNums = normalizedSeasons.map((s) => s.seasonNumber);
  const [selectedSeasons, setSelectedSeasons] = useState<Set<number>>(
    new Set(allSeasonNums.filter((seasonNumber) => seasonNumber !== 0)),
  );
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
    seasonEpisodeRanges: [],
  });

  // 4. 预览与提交状态
  const [preview, setPreview] = useState<PreviewOutcome | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [step, setStep] = useState<0 | 1 | 2>(0);
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
          setSelectedStorageId((current) => current || initialStorageId || data.drives![0]!.id);
        }
      })
      .catch(() => {});
  }, [isOpen, initialStorageId]);

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    fetch(`/api/titles/subscription-policy?tmdbId=${tmdbId}&mediaType=${mediaType}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { policy?: Record<string, unknown> } | null) => {
        if (!alive || !data?.policy) return;
        setDraft((prev) => mergeLoadedPolicy(prev, data.policy as Record<string, unknown>));
        setActivePreset("custom");
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [isOpen, tmdbId, mediaType]);

  const runPreview = async (): Promise<boolean> => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await fetch("/api/titles/subscription-policy/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tmdbId,
          mediaType,
          seasonNumbers: isTv ? Array.from(selectedSeasons).sort((a, b) => a - b) : [],
          policy: draftToPolicy(draft),
        }),
      });
      const body: unknown = await res.json().catch(() => null);
      const mapped = mapPreviewResponse(res.status, body);
      if (mapped.kind === "previewed") {
        setPreview(mapped.outcome);
        return true;
      }
      setPreviewError(mapped.kind === "failed" || mapped.kind === "rejected" ? mapped.copy : "预览失败，请重试");
      return false;
    } catch {
      setPreviewError("网络错误，预览未执行");
      return false;
    } finally {
      setPreviewLoading(false);
    }
  };

  const continueToReview = async () => {
    if (await runPreview()) setStep(2);
  };

  const applyPreset = (preset: "4k" | "1080p" | "anime" | "custom") => {
    setActivePreset(preset);
    const next = createPresetDraft(preset, draft);
    setDraft(next);
    setPreview(null);
  };

  const toggleChip = (field: "mustContain" | "mustNotContain", chip: string) => {
    const nextDraft = { ...draft, [field]: toggleChipString(draft[field], chip) };
    setDraft(nextDraft);
    setActivePreset("custom");
    setPreview(null);
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

  const handleToggleExcludeSpecial = (exclude: boolean) => {
    setExcludeSpecial(exclude);
    setSelectedSeasons((current) => {
      const next = new Set(current);
      if (exclude) next.delete(0);
      else if (allSeasonNums.includes(0)) next.add(0);
      return next;
    });
  };

  const selectAllSeasons = () => setSelectedSeasons(new Set(allSeasonNums.filter((number) => !excludeSpecial || number !== 0)));
  const selectLatestSeason = () => {
    const available = allSeasonNums.filter((number) => !excludeSpecial || number !== 0);
    if (available.length > 0) setSelectedSeasons(new Set([available[available.length - 1]!]));
  };

  // 提交并启动订阅/获取工作流
  const handleSubmit = async () => {
    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const policyPayload = draftToPolicy(draft);

      const savePolicy = async () => {
        const response = await fetch("/api/titles/subscription-policy", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tmdbId,
            mediaType,
            policy: policyPayload,
          }),
        });
        const body: unknown = await response.json().catch(() => null);
        const payload = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
        return {
          ok: response.ok,
          ...(typeof payload["error"] === "string" ? { error: payload["error"] } : {}),
        };
      };

      const actionResult = shouldQueueAcquisition
        ? await savePolicyBeforeAcquisition(savePolicy, async () => {
            const result = await dispatchImmediateAcquisition({
              tmdbId,
              isTv,
              selectedStorageId,
              selectedSeasons,
            });
            if (result.status === "unsupported" || result.status === "llm_not_configured") {
              throw new Error(result.message);
            }
            return result;
          })
        : await savePolicyBeforeAcquisition(savePolicy, async () => ({
            status: "already_tracked",
            message: "订阅策略已保存，后续巡检会使用新设置。",
          }));

      onSuccess?.(actionResult);
      onClose();
      router.refresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "保存失败，尚未启动获取任务");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBack = () => {
    if (step === 0) onClose();
    else {
      setPreview(null);
      setStep(step === 2 ? 1 : 0);
    }
  };

  const handleContinue = () => {
    if (step === 0) setStep(1);
    else if (step === 1) void continueToReview();
    else void handleSubmit();
  };

  const handleDraftChange = (patch: Partial<PolicyDraft>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    setActivePreset("custom");
    setPreview(null);
  };

  const handleMustContainChange = (value: string) => handleDraftChange({ mustContain: value });
  const handleMustNotContainChange = (value: string) => handleDraftChange({ mustNotContain: value });
  return (
    <SubscriptionModalView
      isOpen={isOpen}
      mounted={mounted}
      onClose={onClose}
      title={title}
      year={year}
      posterPath={posterPath}
      initialTracked={initialTracked}
      step={step}
      setStep={setStep}
      isTv={isTv}
      shouldQueueAcquisition={shouldQueueAcquisition}
      normalizedSeasons={normalizedSeasons}
      allSeasonNums={allSeasonNums}
      selectedSeasons={selectedSeasons}
      excludeSpecial={excludeSpecial}
      onToggleSeason={handleToggleSeason}
      onSelectAll={selectAllSeasons}
      onSelectLatest={selectLatestSeason}
      onToggleExcludeSpecial={handleToggleExcludeSpecial}
      drives={drives}
      selectedStorageId={selectedStorageId}
      onSelectStorageId={setSelectedStorageId}
      activePreset={activePreset}
      draft={draft}
      preview={preview}
      previewLoading={previewLoading}
      previewError={previewError}
      onApplyPreset={applyPreset}
      onToggleChip={toggleChip}
      onDraftChange={handleDraftChange}
      onMustContainChange={handleMustContainChange}
      onMustNotContainChange={handleMustNotContainChange}
      runPreview={runPreview}
      errorMsg={errorMsg}
      isSubmitting={isSubmitting}
      onBack={handleBack}
      onContinue={handleContinue}
    />
  );
}
