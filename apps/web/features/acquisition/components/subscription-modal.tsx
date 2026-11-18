"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { buildMovieCandidateId } from "@media-track/workflow";
import {
  requestTrackingAction,
  requestSelectedSeasonsAction,
} from "../../../app/actions/acquisition-actions";
import {
  PRESETS,
  createBlankDraft,
  draftToPolicy,
  mapPolicyLoadResponse,
  toggleTerm,
  validateDraft,
  type PolicyDraft,
  type PresetKind,
} from "../core/policy-draft";
import {
  mapPreviewResponse,
  type PreviewOutcome,
  type PreviewProgress,
} from "../core/policy-preview";
import { consumePreviewStream } from "../core/preview-stream";
import { useResourceCooldown } from "../hooks/use-resource-cooldown";
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

/** 非流式预览（服务端没按 NDJSON 返回时）：与流式各自的 done 事件同一映射。 */
async function readJsonPreview(response: Response): Promise<PrefetchResult> {
  const body: unknown = await response.json().catch(() => null);
  const mapped = mapPreviewResponse(response.status, body);
  return mapped.ok
    ? { outcome: mapped.outcome, failure: null, retryAfterMs: 0 }
    : { outcome: null, failure: mapped.copy, retryAfterMs: mapped.retryAfterMs ?? 0 };
}

export interface PrefetchResult {
  outcome: PreviewOutcome | null;
  failure: string | null;
  /** 429 时服务端给出的剩余冷却毫秒数；0 = 不是限流。 */
  retryAfterMs: number;
}

/** 从已存策略读出草稿：失败/没配过都保持默认草稿（默认草稿本身是合法规则）。 */
function mergeLoadedPolicy(prev: PolicyDraft, policy: unknown): PolicyDraft {
  const loaded = mapPolicyLoadResponse(200, { policy });
  return loaded ? { ...prev, ...loaded } : prev;
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

  const [drives, setDrives] = useState<ConnectedDriveSummary[]>([]);
  const [selectedStorageId, setSelectedStorageId] = useState<string>(initialStorageId ?? "");

  const isTv = mediaType !== "movie";
  const shouldQueueAcquisition = !initialTracked || isTv;
  const normalizedSeasons = resolveNormalizedSeasons(seasonsProp, seasonNumbersProp);
  const allSeasonNums = normalizedSeasons.map((s) => s.seasonNumber);
  const [selectedSeasons, setSelectedSeasons] = useState<Set<number>>(
    new Set(allSeasonNums.filter((seasonNumber) => seasonNumber !== 0)),
  );
  const [excludeSpecial, setExcludeSpecial] = useState(true);

  const [activePreset, setActivePreset] = useState<PresetKind>("1080p");
  const [draft, setDraft] = useState<PolicyDraft>(() => PRESETS["1080p"].build(createBlankDraft()));

  const [preview, setPreview] = useState<PreviewOutcome | null>(null);
  const [previewProgress, setPreviewProgress] = useState<PreviewProgress | null>(null);
  const latestRequestRef = useRef(0);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [throttleMs, setThrottleMs] = useState(0);
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const validationIssues = useMemo(() => validateDraft(draft), [draft]);
  const isDirty = useMemo(() => step === 1 || step === 2 || activePreset === "custom", [step, activePreset]);

  // 429 的倒计时：用服务端给的剩余毫秒驱动「预览效果」按钮，不靠猜。
  const previewCooldown = useResourceCooldown({
    retryAfterMs: throttleMs > 0 ? throttleMs : undefined,
    isThrottled: throttleMs > 0,
    busy: previewProgress !== null,
    defaultButtonLabel: "预览效果",
    onRecover: () => setThrottleMs(0),
  });
  /** 只有用户点过一次「继续/预览」之后才显示校验错误，避免打字途中满屏飘红。 */
  const [validationRequested, setValidationRequested] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

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
      .then(async (res) => {
        const body: unknown = await res.json().catch(() => null);
        return mapPolicyLoadResponse(res.status, body);
      })
      .then((loaded) => {
        if (!alive || loaded === null) return;
        setDraft((prev) => mergeLoadedPolicy(prev, loaded));
        setActivePreset("custom");
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [isOpen, tmdbId, mediaType]);

  const invalidatePreview = () => {
    setPreview(null);
    setPreviewProgress(null);
    setPreviewError(null);
    latestRequestRef.current += 1;
  };

  const runPreview = async (): Promise<boolean> => {
    latestRequestRef.current += 1;
    const requestId = latestRequestRef.current;
    setPreview(null);
    setPreviewError(null);
    setPreviewProgress({ done: 0, total: 0 });
    try {
      const response = await fetch("/api/titles/subscription-policy/preview?stream=1", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/x-ndjson, application/json" },
        body: JSON.stringify({
          tmdbId,
          mediaType,
          seasonNumbers: isTv ? Array.from(selectedSeasons).sort((a, b) => a - b) : [],
          policy: draftToPolicy(draft),
        }),
      });

      const contentType = response.headers.get("content-type") ?? "";
      const streamed = contentType.includes("application/x-ndjson") && response.body !== null;
      const result = streamed
        ? await consumePreviewStream(response.body!, { onProgress: setPreviewProgress })
        : await readJsonPreview(response);
      setPreviewProgress(null);
      if (result.outcome !== null) {
        // 迟到的旧请求不许把结果贴到新表单下面（requestId 已经变化就作废）。
        if (requestId !== latestRequestRef.current) return false;
        setPreview(result.outcome);
        setThrottleMs(0);
        return true;
      }
      // 429 是「等一下」，不是「规则错了」：把倒计时窗口记下来，按钮在该窗口内禁用。
      if (result.retryAfterMs > 0) setThrottleMs(result.retryAfterMs);
      if (result.retryAfterMs > 0) setThrottleMs(result.retryAfterMs);
      setPreviewError(result.failure ?? "预览失败，请重试");
      return false;
    } catch {
      setPreviewProgress(null);
      setPreviewError("网络错误，预览未执行");
      return false;
    }
  };

  const continueToReview = async () => {
    setValidationRequested(true);
    if (validationIssues.length > 0) return;
    if (await runPreview()) setStep(2);
  };

  const applyPreset = (preset: PresetKind) => {
    setActivePreset(preset);
    setDraft((current) => PRESETS[preset].build(current));
    invalidatePreview();
  };

  const toggleChip = (field: "mustContain" | "mustNotContain", chip: string) => {
    setDraft((current) => ({ ...current, [field]: toggleTerm(current[field], chip, current.useRegex) }));
    setActivePreset("custom");
    invalidatePreview();
  };

  const handleToggleSeason = (seasonNumber: number) => {
    setSelectedSeasons((current) => {
      const next = new Set(current);
      if (next.has(seasonNumber)) {
        if (next.size > 1) next.delete(seasonNumber);
      } else {
        next.add(seasonNumber);
      }
      return next;
    });
    // 取消的季度不应把它的起止集留在策略里：不可见的规则比没有规则更危险。
    setDraft((current) => {
      const willRemove = selectedSeasons.has(seasonNumber);
      if (!willRemove) return current;
      const ranges = (current.seasonEpisodeRanges ?? []).filter((range) => range.seasonNumber !== seasonNumber);
      return { ...current, seasonEpisodeRanges: ranges };
    });
    invalidatePreview();
  };

  const handleToggleExcludeSpecial = (exclude: boolean) => {
    setExcludeSpecial(exclude);
    setSelectedSeasons((current) => {
      const next = new Set(current);
      if (exclude) next.delete(0);
      else if (allSeasonNums.includes(0)) next.add(0);
      return next;
    });
    if (exclude) {
      setDraft((current) => ({ ...current, seasonEpisodeRanges: (current.seasonEpisodeRanges ?? []).filter((range) => range.seasonNumber !== 0) }));
    }
    invalidatePreview();
  };

  const selectAllSeasons = () => setSelectedSeasons(new Set(allSeasonNums.filter((number) => !excludeSpecial || number !== 0)));
  const selectLatestSeason = () => {
    const available = allSeasonNums.filter((number) => !excludeSpecial || number !== 0);
    if (available.length > 0) setSelectedSeasons(new Set([available[available.length - 1]!]));
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      const policyPayload = draftToPolicy(draft);
      const savePolicy = async () => {
        const response = await fetch("/api/titles/subscription-policy", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tmdbId, mediaType, policy: policyPayload }),
        });
        const body: unknown = await response.json().catch(() => null);
        const payload = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
        return { ok: response.ok, ...(typeof payload["error"] === "string" ? { error: payload["error"] } : {}) };
      };

      const actionResult = shouldQueueAcquisition
        ? await savePolicyBeforeAcquisition(savePolicy, async () => {
            const result = await dispatchImmediateAcquisition({ tmdbId, isTv, selectedStorageId, selectedSeasons });
            if (result.status === "unsupported" || result.status === "llm_not_configured") throw new Error(result.message);
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
      invalidatePreview();
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
    invalidatePreview();
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
      previewProgress={previewProgress}
      previewError={previewError}
      previewThrottleSeconds={previewCooldown.isCooldownActive ? previewCooldown.remainingSeconds : 0}
      validationIssues={validationIssues}
      isDirty={isDirty}
      validationRequested={validationRequested}
      onApplyPreset={applyPreset}
      onToggleChip={toggleChip}
      onDraftChange={handleDraftChange}
      onMustContainChange={handleMustContainChange}
      onMustNotContainChange={handleMustNotContainChange}
      onSaveAsTemplate={(current) => draftToPolicy(current)}
      runPreview={runPreview}
      errorMsg={errorMsg}
      isSubmitting={isSubmitting}
      onBack={handleBack}
      onContinue={handleContinue}
    />
  );
}
