"use client";

import { useCallback, useState } from "react";
import type { ResourceCandidateView } from "@media-track/workflow";
import { useRouter } from "../../../lib/use-router";
import {
  type CandidateLinkState,
  ResourceCandidateRow,
  resourceTypeLabel,
} from "./resource-candidate-row";
import {
  appendKeywordChip,
  ResourceSearchBar,
} from "./resource-search-bar";

export { appendKeywordChip, resourceTypeLabel };
export type { CandidateLinkState };

/**
 * 详情页「资源」面板（批次 2 的 UI 部分 + 精准搜索与自定义关键词支持）。
 *
 * 用户价值：
 *  1. 手动查询某部作品的资源、大小、发布时间与做种数。
 *  2. 支持在未追踪状态下进行先验探查（搜索页直达）。
 *  3. 支持自定义搜索关键词与精准按季/按集检索。
 *  4. 选定满意候选后支持「手动入库」。
 *  5. 支持安全受控地查看和复制网盘链接与磁力地址。
 */

export interface ResourcePanelProps {
  tmdbId: number;
  mediaType?: "movie" | "tv" | "anime" | undefined;
  seasonNumbers?: number[] | undefined;
  defaultKeyword?: string | undefined;
  title?: string | undefined;
  year?: number | undefined;
  storageId?: string | undefined;
}

export type PanelState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "streaming";
      candidates: ResourceCandidateView[];
      progress: { done: number; total: number; currentKeyword?: string };
    }
  | {
      kind: "ready";
      candidates: ResourceCandidateView[];
      cached: boolean;
      /** 这次查询落库的快照句柄。null = 缓存命中（DB 才是权威，不重推导）。 */
      snapshotId: string | null;
    }
  | { kind: "throttled"; retryAfterMs: number }
  | { kind: "error"; message: string };

/** 默认冷却：后端没给 retryAfterMs 时按 60s 保守等待（与端点常量一致）。 */
const DEFAULT_RETRY_AFTER_MS = 60_000;

/**
 * 流式 NDJSON 事件 ⇒ 面板状态纯函数映射。
 */
export function mapResourceStreamEvent(
  event: { type: string; [key: string]: unknown },
  prevState?: PanelState,
): PanelState {
  if (event.type === "chunk") {
    return {
      kind: "streaming",
      candidates: (event.allCandidates as ResourceCandidateView[]) ?? [],
      progress: (event.progress as { done: number; total: number; currentKeyword?: string }) ?? { done: 0, total: 1 },
    };
  }
  if (event.type === "done") {
    return {
      kind: "ready",
      candidates: (event.candidates as ResourceCandidateView[]) ?? [],
      cached: Boolean(event.cached),
      snapshotId: typeof event.snapshotId === "string" ? event.snapshotId : null,
    };
  }
  if (event.type === "error") {
    if (event.kind === "throttled") {
      return { kind: "throttled", retryAfterMs: (event.retryAfterMs as number) ?? DEFAULT_RETRY_AFTER_MS };
    }
    return { kind: "error", message: (event.detail as string) ?? "查询失败" };
  }
  return prevState ?? { kind: "idle" };
}

/**
 * HTTP 响应 ⇒ 面板状态。
 */
export function mapResourceResponse(status: number, body: unknown): PanelState {
  if (status === 429) {
    const parsed = body as { retryAfterMs?: number };
    return { kind: "throttled", retryAfterMs: parsed.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS };
  }
  if (status < 200 || status >= 300) {
    const parsed = body as { error?: string };
    return { kind: "error", message: parsed.error ?? `查询失败（${status}）` };
  }
  const parsed = body as {
    candidates: ResourceCandidateView[];
    cached: boolean;
    snapshotId?: string;
  };
  return {
    kind: "ready",
    candidates: parsed.candidates,
    cached: parsed.cached,
    // 缓存命中时后端不回 snapshotId：那一份快照的归属要以 DB 为准，前端不重推导。
    snapshotId: typeof parsed.snapshotId === "string" ? parsed.snapshotId : null,
  };
}

/**
 * 入库 HTTP 响应 ⇒ 导入状态。
 */
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

/** 导入子状态。 */
export type ImportState =
  | { kind: "idle" }
  | { kind: "submitting"; candidateId: string }
  | { kind: "queued" }
  | { kind: "already_running" }
  | { kind: "rejected"; message: string; reason?: string };

interface CandidatesListProps {
  state: Extract<PanelState, { kind: "ready" | "streaming" }>;
  importState: ImportState;
  busy: boolean;
  throttled: boolean;
  submitting: boolean;
  linkStates: Record<string, CandidateLinkState>;
  copiedId: string | null;
  onImportCandidate: (candidateId: string) => void;
  onToggleLink: (candidateId: string) => void;
  onCopyLink: (candidateId: string, text: string) => void;
}

function ResourceCandidatesList({
  state,
  importState,
  busy,
  throttled,
  submitting,
  linkStates,
  copiedId,
  onImportCandidate,
  onToggleLink,
  onCopyLink,
}: CandidatesListProps) {
  if (state.candidates.length === 0) {
    if (state.kind === "streaming") {
      return (
        <p className="title-resources-empty">
          正在检索资源（{state.progress.done}/{state.progress.total}
          {state.progress.currentKeyword ? `·${state.progress.currentKeyword}` : ""}）…
        </p>
      );
    }
    return <p className="title-resources-empty">没有找到可获取的资源。</p>;
  }

  return (
    <>
      <div className="title-resources-summary">
        <span>{state.candidates.length} 个候选</span>
        {state.kind === "streaming" ? (
          <span className="title-resources-cached">
            正在并发检索（{state.progress.done}/{state.progress.total}
            {state.progress.currentKeyword ? `·${state.progress.currentKeyword}` : ""}）…
          </span>
        ) : state.cached ? (
          <span className="title-resources-cached">30 分钟内的缓存结果</span>
        ) : null}
      </div>
      <ul className="title-resources-list">
        {state.candidates.map((candidate) => {
          const importable = state.kind === "ready" && state.snapshotId !== null;
          const rowBusy =
            submitting && importState.kind === "submitting" && importState.candidateId === candidate.candidateId;
          return (
            <ResourceCandidateRow
              key={candidate.candidateId}
              candidate={candidate}
              importable={importable}
              rowBusy={rowBusy}
              busy={busy}
              throttled={throttled}
              streaming={state.kind === "streaming"}
              linkInfo={linkStates[candidate.candidateId]}
              copied={copiedId === candidate.candidateId}
              onImport={() => void onImportCandidate(candidate.candidateId)}
              onToggleLink={() => void onToggleLink(candidate.candidateId)}
              onCopyLink={(text) => void onCopyLink(candidate.candidateId, text)}
            />
          );
        })}
      </ul>

      {importState.kind === "queued" && (
        <p className="title-resources-import-queued">已加入队列，正在转存到网盘。可以离开这个页面。</p>
      )}
      {importState.kind === "already_running" && (
        <p className="title-resources-import-queued">这部片已有导入在进行中。</p>
      )}
      {importState.kind === "rejected" && (
        <p className="title-resources-error">入库失败：{importState.message}</p>
      )}
    </>
  );
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
        onEvent(JSON.parse(trimmed) as { type: string; [key: string]: unknown });
      } catch {
        // ignore malformed line
      }
    }
  }
}

export function TitleResourcePanel({
  tmdbId,
  mediaType,
  seasonNumbers,
  defaultKeyword,
  title,
  year,
  storageId,
}: ResourcePanelProps) {
  const [state, setState] = useState<PanelState>({ kind: "idle" });
  const [importState, setImportState] = useState<ImportState>({ kind: "idle" });
  const [linkStates, setLinkStates] = useState<Record<string, CandidateLinkState>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [customKeyword, setCustomKeyword] = useState<string>(
    () => defaultKeyword?.trim() || title?.trim() || "",
  );
  const [selectedSeason, setSelectedSeason] = useState<number | undefined>(undefined);
  const [selectedEpisode, setSelectedEpisode] = useState<string>("");
  const router = useRouter();

  const search = useCallback(async () => {
    setState({ kind: "loading" });
    setLinkStates({});
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
        setState(mapResourceResponse(response.status, body));
      }
    } catch (error) {
      // 网络层失败也降级为空态，不把异常抛给页面
      setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [tmdbId, mediaType, customKeyword, selectedSeason, selectedEpisode, storageId]);

  const handleToggleLink = useCallback(
    async (candidateId: string) => {
      const existing = linkStates[candidateId];
      if (existing?.open) {
        setLinkStates((prev) => ({
          ...prev,
          [candidateId]: { ...existing, open: false },
        }));
        return;
      }
      if (existing?.data) {
        setLinkStates((prev) => ({
          ...prev,
          [candidateId]: { ...existing, open: true },
        }));
        return;
      }

      if (state.kind !== "ready" || state.snapshotId === null) {
        const error =
          state.kind === "streaming"
            ? "请等待搜索完成生成快照后再查看链接"
            : "缓存结果无链接快照，请重新查询";
        setLinkStates((prev) => ({
          ...prev,
          [candidateId]: { open: true, loading: false, error },
        }));
        return;
      }

      setLinkStates((prev) => ({
        ...prev,
        [candidateId]: { open: true, loading: true },
      }));

      try {
        const response = await fetch("/api/titles/resources/link", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tmdbId,
            snapshotId: state.snapshotId,
            candidateId,
          }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          candidateId?: string;
          title?: string;
          type?: string;
          link?: CandidateLinkState["data"] extends { link: infer L } ? L : never;
        };
        if (!response.ok) {
          setLinkStates((prev) => ({
            ...prev,
            [candidateId]: {
              open: true,
              loading: false,
              error: body.error ?? `获取失败 (${response.status})`,
            },
          }));
          return;
        }
        setLinkStates((prev) => ({
          ...prev,
          [candidateId]: {
            open: true,
            loading: false,
            data: body as CandidateLinkState["data"],
          },
        }));
      } catch (err) {
        setLinkStates((prev) => ({
          ...prev,
          [candidateId]: {
            open: true,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          },
        }));
      }
    },
    [linkStates, state, tmdbId],
  );

  const handleCopyLink = useCallback(async (candidateId: string, text: string) => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      setCopiedId(candidateId);
      setTimeout(() => {
        setCopiedId((curr) => (curr === candidateId ? null : curr));
      }, 2000);
    } catch {
      // ignore clipboard error
    }
  }, []);

  const importCandidate = useCallback(
    async (candidateId: string) => {
      if (state.kind !== "ready" || state.snapshotId === null) return;
      setImportState({ kind: "submitting", candidateId });
      try {
        const response = await fetch("/api/titles/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tmdbId, snapshotId: state.snapshotId, candidateId }),
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
  const throttled = state.kind === "throttled";
  const submitting = importState.kind === "submitting";

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
        retryAfterMs={throttled ? state.retryAfterMs : undefined}
        onSearch={search}
        onKeyDown={onKeyDown}
      />

      {state.kind === "idle" && (
        <p className="title-resources-hint">手动查询这部片的可获取资源。查询会花真实索引器预算，60 秒内不能重复。</p>
      )}

      {(state.kind === "ready" || state.kind === "streaming") && (
        <ResourceCandidatesList
          state={state}
          importState={importState}
          busy={busy}
          throttled={throttled}
          submitting={submitting}
          linkStates={linkStates}
          copiedId={copiedId}
          onImportCandidate={importCandidate}
          onToggleLink={handleToggleLink}
          onCopyLink={handleCopyLink}
        />
      )}

      {state.kind === "throttled" && (
        <p className="title-resources-hint">
          查询太频繁，{Math.ceil(state.retryAfterMs / 1000)} 秒后可再查。
        </p>
      )}

      {state.kind === "error" && (
        <p className="title-resources-error">资源查询失败：{state.message}</p>
      )}
    </section>
  );
}
