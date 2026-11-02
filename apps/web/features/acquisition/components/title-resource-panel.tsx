"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  MergedSourceHealth,
  ResourceCandidateView,
} from "@media-track/workflow";
import { useRouter } from "../../../lib/use-router";
import { useEpisodeTarget } from "./episode-target-context";
import {
  type CandidateLinkState,
  resourceTypeLabel,
} from "./resource-candidate-row";
import {
  appendKeywordChip,
  ResourceSearchBar,
} from "./resource-search-bar";
import {
  ResourceEmptyDiagnostic,
  type ResourceEmptyDiagnosticProps,
} from "./resource-empty-diagnostic";
import {
  DEFAULT_FILTER_CRITERIA,
  extractFacets,
  filterCandidates,
  paginateCandidates,
  type ResourceFilterCriteria,
  sortCandidates,
} from "../contracts/resource-filter-model";
import { ResourceCandidatesList } from "./resource-candidates-list";
import { useCandidateActions } from "../hooks/use-candidate-actions";
import type {
  CandidateInspectionState,
  ImportState,
  PanelState,
} from "../contracts/acquisition-types";
import {
  DEFAULT_RETRY_AFTER_MS,
  transitionOnCooldownExpired,
  transitionToThrottled,
} from "../core/cooldown-model";
import { useResourceCooldown } from "../hooks/use-resource-cooldown";

export { appendKeywordChip, resourceTypeLabel, ResourceEmptyDiagnostic };
export type {
  CandidateLinkState,
  ResourceEmptyDiagnosticProps,
  ImportState,
  PanelState,
};

export interface ResourcePanelProps {
  tmdbId: number;
  mediaType?: "movie" | "tv" | "anime" | undefined;
  seasonNumbers?: number[] | undefined;
  defaultKeyword?: string | undefined;
  title?: string | undefined;
  year?: number | undefined;
  storageId?: string | undefined;
  releaseDate?: string | null | undefined;
}

function resolveSourceHealth(
  eventHealth: unknown,
  prevState?: PanelState,
): MergedSourceHealth | undefined {
  if (eventHealth) return eventHealth as MergedSourceHealth;
  if (prevState && "sourceHealth" in prevState) return prevState.sourceHealth;
  return undefined;
}

export function mapResourceStreamEvent(
  event: { type: string; [key: string]: unknown },
  prevState?: PanelState,
): PanelState {
  if (event.type === "chunk") {
    return {
      kind: "streaming",
      candidates: (event.allCandidates as ResourceCandidateView[]) ?? [],
      progress: (event.progress as { done: number; total: number; currentKeyword?: string }) ?? { done: 0, total: 1 },
      sourceHealth: resolveSourceHealth(event.sourceHealth, prevState),
    };
  }
  if (event.type === "done") {
    return {
      kind: "ready",
      candidates: (event.candidates as ResourceCandidateView[]) ?? [],
      cached: Boolean(event.cached),
      snapshotId: typeof event.snapshotId === "string" ? event.snapshotId : null,
      sourceHealth: resolveSourceHealth(event.sourceHealth, prevState),
    };
  }
  if (event.type === "error") {
    if (event.kind === "throttled") {
      const retryAfterMs = (event.retryAfterMs as number) ?? DEFAULT_RETRY_AFTER_MS;
      return prevState ? transitionToThrottled(prevState, retryAfterMs) : { kind: "throttled", retryAfterMs };
    }
    return { kind: "error", message: (event.detail as string) ?? "查询失败" };
  }
  return prevState ?? { kind: "idle" };
}

export function mapResourceResponse(
  status: number,
  body: unknown,
  prevState?: PanelState,
): PanelState {
  if (status === 429) {
    const parsed = body as { retryAfterMs?: number };
    const retryAfterMs = parsed.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
    return prevState ? transitionToThrottled(prevState, retryAfterMs) : { kind: "throttled", retryAfterMs };
  }
  if (status < 200 || status >= 300) {
    const parsed = body as { error?: string };
    return { kind: "error", message: parsed.error ?? `查询失败（${status}）` };
  }
  const parsed = body as {
    candidates: ResourceCandidateView[];
    cached: boolean;
    snapshotId?: string;
    sourceHealth?: MergedSourceHealth;
  };
  return {
    kind: "ready",
    candidates: parsed.candidates,
    cached: parsed.cached,
    snapshotId: typeof parsed.snapshotId === "string" ? parsed.snapshotId : null,
    sourceHealth: parsed.sourceHealth,
  };
}

export function mapImportResponse(status: number, body: unknown): ImportState {
  if (status === 202) {
    return { kind: "queued" };
  }
  if (status === 200) {
    return { kind: "already_running" };
  }
  const parsed = body as { error?: string; reason?: string };
  const message = parsed.error ?? `入库失败（${status}）`;
  return parsed.reason === undefined
    ? { kind: "rejected", message }
    : { kind: "rejected", message, reason: parsed.reason };
}

async function consumeResourceNdjsonStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: { type: string; [key: string]: unknown }) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { type?: unknown; [key: string]: unknown };
        if (typeof parsed?.type === "string") {
          onEvent(parsed as { type: string; [key: string]: unknown });
        }
      } catch {
        // ignore malformed line
      }
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    try {
      const parsed = JSON.parse(trailing) as { type?: unknown; [key: string]: unknown };
      if (typeof parsed?.type === "string") {
        onEvent(parsed as { type: string; [key: string]: unknown });
      }
    } catch {
      // ignore
    }
  }
}

function createSearchLoadingState(prev: PanelState): PanelState {
  const previousCandidates =
    prev.kind === "ready"
      ? prev.candidates
      : prev.kind === "throttled" || prev.kind === "loading"
        ? prev.previousCandidates
        : undefined;
  const previousSnapshotId =
    prev.kind === "ready"
      ? prev.snapshotId
      : prev.kind === "throttled" || prev.kind === "loading"
        ? prev.previousSnapshotId
        : undefined;
  const sourceHealth = "sourceHealth" in prev ? prev.sourceHealth : undefined;
  return {
    kind: "loading",
    previousCandidates,
    previousSnapshotId,
    sourceHealth,
  };
}

function resolveDisplayState(
  state: PanelState,
): Extract<PanelState, { kind: "ready" | "streaming" }> | null {
  if (state.kind === "ready" || state.kind === "streaming") {
    return state;
  }
  if (state.kind === "throttled" && state.previousCandidates && state.previousCandidates.length > 0) {
    return {
      kind: "ready",
      candidates: state.previousCandidates,
      cached: true,
      snapshotId: state.previousSnapshotId ?? null,
      sourceHealth: state.sourceHealth,
    };
  }
  return null;
}

function resolveTargetSnapshotId(state: PanelState): string | null {
  if (state.kind === "ready") return state.snapshotId;
  if (state.kind === "throttled") return state.previousSnapshotId ?? null;
  return null;
}

export function TitleResourcePanel({
  tmdbId,
  mediaType = "movie",
  seasonNumbers,
  defaultKeyword,
  title,
  year,
  storageId,
  releaseDate,
}: ResourcePanelProps) {
  const [state, setState] = useState<PanelState>({ kind: "idle" });
  const [importState, setImportState] = useState<ImportState>({ kind: "idle" });
  const [customKeyword, setCustomKeyword] = useState<string>(
    () => defaultKeyword?.trim() || title?.trim() || "",
  );
  const [selectedSeason, setSelectedSeason] = useState<number | undefined>(undefined);
  const [selectedEpisode, setSelectedEpisode] = useState<string>("");
  const [criteria, setCriteria] = useState<ResourceFilterCriteria>(DEFAULT_FILTER_CRITERIA);
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(10);
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const router = useRouter();
  const { target } = useEpisodeTarget();

  useEffect(() => {
    if (target) {
      setSelectedSeason(target.seasonNumber);
      setSelectedEpisode(String(target.episodeNumber));
    }
  }, [target]);

  const throttled = state.kind === "throttled";
  const retryAfterMs = throttled ? state.retryAfterMs : undefined;

  const handleCooldownRecover = useCallback(() => {
    setState((prev) => transitionOnCooldownExpired(prev));
  }, []);

  const { remainingSeconds, hintText } = useResourceCooldown({
    retryAfterMs,
    isThrottled: throttled,
    busy: state.kind === "loading" || state.kind === "streaming",
    onRecover: handleCooldownRecover,
  });

  const snapshotIdForActions = resolveTargetSnapshotId(state);

  const {
    linkStates,
    inspectionStates,
    copiedId,
    handleToggleLink,
    handleInspectCandidate,
    handleCopyLink,
    resetActions,
  } = useCandidateActions({
    tmdbId,
    snapshotId: snapshotIdForActions,
    streaming: state.kind === "streaming",
  });

  const handleCriteriaChange = useCallback(
    (updater: (prev: ResourceFilterCriteria) => ResourceFilterCriteria) => {
      setCriteria(updater);
      setPage(1);
    },
    [],
  );

  const handleResetCriteria = useCallback(() => {
    setCriteria(DEFAULT_FILTER_CRITERIA);
    setPage(1);
  }, []);

  const handlePageSizeChange = useCallback((newSize: number) => {
    setPageSize(newSize);
    setPage(1);
  }, []);

  const handleOpenModal = useCallback(() => setIsModalOpen(true), []);
  const handleCloseModal = useCallback(() => setIsModalOpen(false), []);

  const handleResetKeyword = useCallback(() => {
    const base = defaultKeyword?.trim() || title?.trim() || "";
    setCustomKeyword(base);
  }, [defaultKeyword, title]);

  const search = useCallback(async () => {
    setState((prev) => createSearchLoadingState(prev));
    resetActions();
    try {
      const epNum = selectedEpisode.trim() ? parseInt(selectedEpisode.trim(), 10) : undefined;
      const response = await fetch("/api/titles/resources?stream=1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/x-ndjson, application/json",
        },
        body: JSON.stringify({
          tmdbId,
          type: mediaType,
          customKeyword: customKeyword.trim() || undefined,
          seasonNumber: selectedSeason,
          episodeNumber: Number.isInteger(epNum) && epNum! > 0 ? epNum : undefined,
          storageId,
        }),
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/x-ndjson") && response.body) {
        await consumeResourceNdjsonStream(response.body, (event) => {
          setState((prev) => mapResourceStreamEvent(event, prev));
        });
      } else {
        const body = await response.json().catch(() => ({}));
        setState((prev) => mapResourceResponse(response.status, body, prev));
      }
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [tmdbId, mediaType, customKeyword, selectedSeason, selectedEpisode, storageId, resetActions]);

  const importCandidate = useCallback(
    async (candidateId: string) => {
      const targetSnapshotId = resolveTargetSnapshotId(state);
      if (targetSnapshotId === null) return;
      setImportState({ kind: "submitting", candidateId });
      try {
        const response = await fetch("/api/titles/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tmdbId, snapshotId: targetSnapshotId, candidateId }),
        });
        const body = await response.json().catch(() => ({}));
        const next = mapImportResponse(response.status, body);
        setImportState(next);
        if (next.kind === "queued" || next.kind === "already_running") {
          router.refresh();
        }
      } catch (error) {
        setImportState({
          kind: "rejected",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [state, tmdbId, router],
  );

  const busy = state.kind === "loading" || state.kind === "streaming";
  const submitting = importState.kind === "submitting";

  const displayState = useMemo(() => resolveDisplayState(state), [state]);
  const activeCandidates = displayState ? displayState.candidates : [];

  const facets = useMemo(() => extractFacets(activeCandidates), [activeCandidates]);

  const filteredAndSortedCandidates = useMemo(() => {
    if (activeCandidates.length === 0) return [];
    const filtered = filterCandidates(activeCandidates, criteria);
    return sortCandidates(filtered, criteria.sortBy);
  }, [activeCandidates, criteria]);

  const paginatedResult = useMemo(() => {
    return paginateCandidates(filteredAndSortedCandidates, page, pageSize);
  }, [filteredAndSortedCandidates, page, pageSize]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter" && !busy && !throttled) {
      void search();
    }
  };

  return (
    <section className="hub-panel title-resources" id="title-resources" aria-label="资源">
      <header className="title-resources-head">
        <h2>资源检索</h2>
      </header>

      <ResourceSearchBar
        customKeyword={customKeyword}
        setCustomKeyword={setCustomKeyword}
        selectedSeason={selectedSeason}
        setSelectedSeason={setSelectedSeason}
        selectedEpisode={selectedEpisode}
        setSelectedEpisode={setSelectedEpisode}
        mediaType={mediaType}
        seasonNumbers={seasonNumbers}
        title={title}
        year={year}
        busy={busy}
        throttled={throttled}
        remainingSeconds={throttled ? remainingSeconds : undefined}
        retryAfterMs={throttled ? state.retryAfterMs : undefined}
        onSearch={search}
        onKeyDown={onKeyDown}
      />

      {state.kind === "idle" && (
        <p className="title-resources-hint">手动查询这部片的可获取资源。查询会花真实索引器预算，60 秒内不能重复。</p>
      )}

      {displayState !== null && (
        <ResourceCandidatesList
          state={displayState}
          criteria={criteria}
          facets={facets}
          paginatedResult={paginatedResult}
          isModalOpen={isModalOpen}
          importState={importState}
          busy={busy}
          throttled={throttled}
          submitting={submitting}
          linkStates={linkStates}
          inspectionStates={inspectionStates}
          copiedId={copiedId}
          releaseDate={releaseDate}
          baseTitle={title || defaultKeyword}
          year={year}
          customKeyword={customKeyword}
          onResetKeyword={handleResetKeyword}
          onCriteriaChange={handleCriteriaChange}
          onResetCriteria={handleResetCriteria}
          onPageChange={setPage}
          onPageSizeChange={handlePageSizeChange}
          onOpenModal={handleOpenModal}
          onCloseModal={handleCloseModal}
          onImportCandidate={importCandidate}
          onToggleLink={handleToggleLink}
          onCopyLink={handleCopyLink}
          onInspectCandidate={handleInspectCandidate}
        />
      )}

      {state.kind === "throttled" && (
        <p className="title-resources-hint tone-warning" role="status" aria-live="polite">
          {hintText || `查询太频繁，${Math.ceil(state.retryAfterMs / 1000)} 秒后可再查。`}
        </p>
      )}

      {state.kind === "error" && (
        <p className="title-resources-error">资源查询失败：{state.message}</p>
      )}
    </section>
  );
}
