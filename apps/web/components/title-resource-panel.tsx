"use client";

import { useCallback, useState } from "react";
import { Search, X } from "lucide-react";
import type { ResourceCandidateView, ResourceType } from "@media-track/workflow";
import { useRouter } from "../lib/use-router";

/**
 * 详情页「资源」面板（批次 2 的 UI 部分 + 精准搜索与自定义关键词支持）。
 *
 * 用户价值：
 *  1. 手动查询某部作品的资源、大小、发布时间与做种数。
 *  2. 支持在未追踪状态下进行先验探查（搜索页直达）。
 *  3. 支持自定义搜索关键词与精准按季/按集检索。
 *  4. 选定满意候选后支持「手动入库」。
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
 * HTTP 响应 ⇒ 面板状态。抽成导出纯函数是为了能单测——内联在事件回调里就只能测一个
 * 复本，那是假覆盖。
 *
 * 降级契约（规格 failure mode）：数据源不可用绝不抛到页面外，一律转成 error 态；
 * 429 转成可读的剩余秒数，不是一个裸错误。
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
 *
 * 410 而不是 400：候选曾经有效、只是窗口关了（或它不属于这次搜索）。用户的下一步
 * 一样——重新查询——而 410 告诉客户端别再原样重试。
 * 200 already_running 不当成错误：什么都没新入队，报错会让用户以为失败了。
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
  // exactOptionalPropertyTypes：拿不准有没有 reason 时不能传 undefined，要整个键不传。
  return parsed.reason === undefined
    ? { kind: "rejected", message }
    : { kind: "rejected", message, reason: parsed.reason };
}

/** 导入子状态。与查询状态分开：查询可以被冷却挡住，导入有它自己的一套终局。 */
export type ImportState =
  | { kind: "idle" }
  | { kind: "submitting"; candidateId: string }
  | { kind: "queued" }
  | { kind: "already_running" }
  | { kind: "rejected"; message: string; reason?: string };

/** 字节数的人类可读形式。provider 不上报体积时整块不渲染。 */
function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatPostedAt(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().slice(0, 10);
}

/**
 * 候选的资源类型 ⇒ 用户看得懂的品牌名。与设置页、各网盘连接组件同一套叫法
 * （115/夸克/天翼/123/光鸭），磁力叫「磁力」—— pansou 的 source 字段虽然也带
 * 品牌，但一枚固定位置的标签让「网盘秒传候选」和「磁力候选」在一眼里分得开，
 * 后者要走 Prowlarr、且依赖网盘的磁力秒传能力。
 */
export function resourceTypeLabel(type: ResourceType): string {
  switch (type) {
    case "115":
      return "115";
    case "quark":
      return "夸克";
    case "uc":
      return "UC";
    case "tianyi":
      return "天翼";
    case "123":
      return "123";
    case "guangya":
      return "光鸭";
    case "magnet":
      return "磁力";
    case "manual":
      return "手动";
  }
}

export function appendKeywordChip(current: string, chip: string): string {
  const trimmed = current.trim();
  const token = chip.trim();
  if (!token) return current;
  if (!trimmed) return token;
  const tokens = trimmed.split(/\s+/);
  if (tokens.some((t) => t.toLowerCase() === token.toLowerCase())) {
    return trimmed;
  }
  return `${trimmed} ${token}`;
}

const MODIFIER_CHIPS = ["4K", "1080p", "简日内嵌", "原盘"] as const;

interface QuickChipsProps {
  customKeyword: string;
  setCustomKeyword: (v: string) => void;
  title?: string | undefined;
  year?: number | undefined;
}

function ResourceQuickChips({
  customKeyword,
  setCustomKeyword,
  title,
  year,
}: QuickChipsProps) {
  const cleanTitle = title?.trim();

  return (
    <div className="title-resources-quick-chips">
      <span className="title-resources-quick-label">快捷词：</span>
      {cleanTitle ? (
        <button
          type="button"
          className="title-resources-chip"
          onClick={() => setCustomKeyword(cleanTitle)}
          title="以原片名检索"
        >
          {cleanTitle}
        </button>
      ) : null}
      {cleanTitle && year && Number.isInteger(year) ? (
        <button
          type="button"
          className="title-resources-chip"
          onClick={() => setCustomKeyword(`${cleanTitle} ${year}`)}
          title="以片名+年份检索"
        >
          {cleanTitle} {year}
        </button>
      ) : null}
      {MODIFIER_CHIPS.map((mod) => (
        <button
          key={mod}
          type="button"
          className="title-resources-chip"
          onClick={() => setCustomKeyword(appendKeywordChip(customKeyword, mod))}
          title={`追加 ${mod} 过滤词`}
        >
          + {mod}
        </button>
      ))}
    </div>
  );
}

interface SearchBarProps {
  customKeyword: string;
  setCustomKeyword: (v: string) => void;
  selectedSeason: number | undefined;
  setSelectedSeason: (v: number | undefined) => void;
  selectedEpisode: string;
  setSelectedEpisode: (v: string) => void;
  mediaType?: "movie" | "tv" | "anime" | undefined;
  seasonNumbers?: readonly number[] | undefined;
  title?: string | undefined;
  year?: number | undefined;
  busy: boolean;
  throttled: boolean;
  retryAfterMs?: number | undefined;
  onSearch: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

function ResourceSearchBar({
  customKeyword,
  setCustomKeyword,
  selectedSeason,
  setSelectedSeason,
  selectedEpisode,
  setSelectedEpisode,
  mediaType,
  seasonNumbers,
  title,
  year,
  busy,
  throttled,
  retryAfterMs,
  onSearch,
  onKeyDown,
}: SearchBarProps) {
  return (
    <div className="title-resources-search-bar">
      <div className="title-resources-input-wrap">
        <Search size={14} aria-hidden />
        <input
          type="text"
          value={customKeyword}
          onChange={(e) => setCustomKeyword(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="自定义搜索关键词（如：4K 喵萌奶茶屋 S01...）"
          aria-label="自定义搜索关键词"
        />
        {customKeyword.trim() ? (
          <button
            type="button"
            className="title-resources-input-clear"
            aria-label="清空关键词"
            onClick={() => setCustomKeyword("")}
          >
            <X size={12} aria-hidden />
          </button>
        ) : null}
      </div>

      {mediaType !== "movie" && seasonNumbers && seasonNumbers.length > 1 ? (
        <select
          className="title-resources-select"
          value={selectedSeason ?? ""}
          onChange={(e) => setSelectedSeason(e.target.value ? Number(e.target.value) : undefined)}
          aria-label="选择季度"
        >
          <option value="">全部季</option>
          {seasonNumbers.map((num) => (
            <option key={num} value={num}>
              第 {num} 季
            </option>
          ))}
        </select>
      ) : null}

      {mediaType !== "movie" ? (
        <input
          type="number"
          min="1"
          className="title-resources-number-input"
          value={selectedEpisode}
          onChange={(e) => setSelectedEpisode(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="集数(选填)"
          aria-label="指定集数"
        />
      ) : null}

      <button
        type="button"
        className="title-resources-search"
        onClick={onSearch}
        disabled={busy || throttled}
      >
        {busy ? "查询中…" : throttled ? `请稍候 ${Math.ceil((retryAfterMs ?? 0) / 1000)}s` : "查询资源"}
      </button>

      <ResourceQuickChips
        customKeyword={customKeyword}
        setCustomKeyword={setCustomKeyword}
        title={title}
        year={year}
      />
    </div>
  );
}

interface CandidatesListProps {
  state: Extract<PanelState, { kind: "ready" | "streaming" }>;
  importState: ImportState;
  busy: boolean;
  throttled: boolean;
  submitting: boolean;
  onImportCandidate: (candidateId: string) => void;
}

function ResourceCandidatesList({
  state,
  importState,
  busy,
  throttled,
  submitting,
  onImportCandidate,
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
            <li key={candidate.candidateId} className="title-resources-item">
              <div className="title-resources-item-main">
                <span className="title-resources-item-title" title={candidate.title}>
                  {candidate.title}
                </span>
                <span className="title-resources-item-meta">
                  <span className="resource-type-chip">{resourceTypeLabel(candidate.type)}</span>
                  {candidate.sizeBytes !== undefined && ` · ${formatSize(candidate.sizeBytes)}`}
                  {candidate.postedAt !== undefined && ` · ${formatPostedAt(candidate.postedAt)}`}
                  {candidate.seeders !== undefined && ` · ${candidate.seeders} 做种`}
                </span>
              </div>
              <button
                type="button"
                className="title-resources-import"
                onClick={() => void onImportCandidate(candidate.candidateId)}
                disabled={!importable || rowBusy || busy || throttled}
                title={
                  state.kind === "streaming"
                    ? "检索全部完成生成快照后即可入库（首批结果已展示）"
                    : importable
                      ? undefined
                      : "这是 30 分钟内的缓存结果，请重新查询后再入库"
                }
              >
                {rowBusy ? "入库中…" : "手动入库"}
              </button>
            </li>
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
  const [customKeyword, setCustomKeyword] = useState<string>(
    () => defaultKeyword?.trim() || title?.trim() || "",
  );
  const [selectedSeason, setSelectedSeason] = useState<number | undefined>(undefined);
  const [selectedEpisode, setSelectedEpisode] = useState<string>("");
  const router = useRouter();

  const search = useCallback(async () => {
    setState({ kind: "loading" });
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

  /**
   * 手动入库。只递不透明句柄；分享链从头到尾没到过前端。
   *
   * 202 之后不自己计时——setState({kind:"queued"}) 只是把按钮换成「已入队」，
   * 真正的进度来自 router.refresh()：服务端的 view.acquiring 已经包含 manual_import，
   * 刷新后页面挂上 AcquiringPoller，由它轮询到 run 结束。徽章因此始终是服务端真相。
   */
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
        // 入队成功 ⇒ 让服务端重渲染，它才知道这部片有活儿在飞
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
          onImportCandidate={importCandidate}
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
