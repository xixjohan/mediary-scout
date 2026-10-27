"use client";

import { useCallback, useState } from "react";
import type { ResourceCandidateView } from "@media-track/workflow";
import { useRouter } from "../lib/use-router";

/**
 * 详情页「资源」面板（批次 2 的 UI 部分）。
 *
 * 用户价值（plan 原话）：「终于能看到某部片有哪些资源、多大、什么时候发的」——
 * 即使还不能一键入库（那是批次 3）。所以这块**只读**：一个查询按钮 + 一份候选列表。
 *
 * 三条边界，都是 plan 钉死的：
 *  1. 仅手动触发。没有自动轮询、没有进页面即搜——每一次查询都花真实索引器预算，
 *     而 §2.3 实测一次转存要过 1.2s 漏桶加数十次 drive 调用。
 *  2. 响应里没有 URL。后端只回 id/title/type/source/postedAt/sizeBytes，分享链和
 *     提取码留在服务端。前端拿到的 candidateId 是**不透明句柄，不是 URL**——所以
 *     这里不渲染任何可点开的链接，只渲染标题与元信息。
 *  3. 冷却期禁用按钮并显示剩余秒数。后端 60s 冷却会还给我们 retryAfterMs，
 *     禁用是为了不制造注定失败的请求，不是因为要教用户规矩。
 *
 * 批次 3 在此基础上加了「手动入库」。它没有放宽上面任何一条：查询仍然只手动触发，
 * 响应里仍然没有 URL。多出来的只是每行候选一个按钮，点了之后：
 *
 *   · 前端把 **不透明句柄**（snapshotId + candidateId）POST 给 /api/titles/import。
 *     分享链和提取码自始至终没有出现在前端——它们随 run 落在服务端，由 worker 读回。
 *   · 202 之后前端只做一件事：router.refresh()。进度不是前端自己计的——服务端的
 *     `view.acquiring` 已经包含 manual_import（用户可见 + queued 算 active），刷新后
 *     页面挂上 AcquiringPoller，由它持续轮询到 run 结束。徽章因此是服务端真相的投影，
 *     关掉浏览器再回来也还在（AcquiringPoller 的设计前提）。
 *
 * 数据源不可用时降级为空态 + 错误说明，不抛到页面外（规格 failure mode）。
 */

interface ResourcePanelProps {
  tmdbId: number;
}

export type PanelState =
  | { kind: "idle" }
  | { kind: "loading" }
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

export function TitleResourcePanel({ tmdbId }: ResourcePanelProps) {
  const [state, setState] = useState<PanelState>({ kind: "idle" });
  const [importState, setImportState] = useState<ImportState>({ kind: "idle" });
  const router = useRouter();

  const search = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const response = await fetch("/api/titles/resources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tmdbId }),
      });
      const body = await response.json().catch(() => ({}));
      setState(mapResourceResponse(response.status, body));
    } catch (error) {
      // 网络层失败也降级为空态，不把异常抛给页面
      setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [tmdbId]);

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

  const busy = state.kind === "loading";
  const throttled = state.kind === "throttled";
  const submitting = importState.kind === "submitting";

  return (
    <section className="title-resources" aria-label="资源">
      <header className="title-resources-head">
        <h2>资源</h2>
        <button
          type="button"
          className="title-resources-search"
          onClick={search}
          disabled={busy || throttled}
        >
          {busy ? "查询中…" : throttled ? `请稍候 ${Math.ceil(state.retryAfterMs / 1000)}s` : "查询资源"}
        </button>
      </header>

      {state.kind === "idle" && (
        <p className="title-resources-hint">手动查询这部片的可获取资源。查询会花真实索引器预算，60 秒内不能重复。</p>
      )}

      {state.kind === "ready" && state.candidates.length === 0 && (
        <p className="title-resources-empty">没有找到可获取的资源。</p>
      )}

      {state.kind === "ready" && state.candidates.length > 0 && (
        <>
          {state.cached && <p className="title-resources-cached">30 分钟内的缓存结果。</p>}
          <ul className="title-resources-list">
            {state.candidates.map((candidate) => {
              // 缓存命中时没有 snapshotId：那一份快照的归属要以 DB 为准，前端不重推导，
              // 所以按钮禁用并说清原因，而不是拿一个猜的句柄去请求。
              const importable = state.snapshotId !== null;
              const rowBusy = submitting && importState.kind === "submitting" && importState.candidateId === candidate.candidateId;
              return (
                <li key={candidate.candidateId} className="title-resources-item">
                  <span className="title-resources-item-title">{candidate.title}</span>
                  <span className="title-resources-item-meta">
                    {candidate.source}
                    {candidate.sizeBytes !== undefined && ` · ${formatSize(candidate.sizeBytes)}`}
                    {candidate.postedAt !== undefined && ` · ${formatPostedAt(candidate.postedAt)}`}
                    {candidate.seeders !== undefined && ` · ${candidate.seeders} 做种`}
                  </span>
                  <button
                    type="button"
                    className="title-resources-import"
                    onClick={() => void importCandidate(candidate.candidateId)}
                    disabled={!importable || rowBusy || busy || throttled}
                    title={importable ? undefined : "这是 30 分钟内的缓存结果，请重新查询后再入库"}
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
