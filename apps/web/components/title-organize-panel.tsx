"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Batch 4: the 自动整理 panel (plan §3.4, L1/L2).
 *
 * The panel exists to make the two levels legible to the user:
 *
 *   L1 确定性   命名规范 ⇒ 直接放对，面板只说「做了什么」
 *   L2 人工复核 命名混乱 ⇒ 面板列出**每一个文件和建议目标**，用户确认或改判
 *
 * It deliberately does NOT have a "用 AI 整理" button. L3 is an explicit opt-in in the
 * plan and it is not built yet — a button that silently falls back to L1 would be the
 * exact failure the plan is guarding against (the user believes an agent looked at
 * their files when nothing did). When L3 lands it gets its own control, not this one
 * growing a mode.
 *
 * Nothing here times anything, and nothing here guesses. The outcome arrives with the
 * response: 200 means the drive confirmed it (or there is a review to look at), 409
 * means it did not and the run stopped. There is no client-side countdown to get out of
 * sync with the drive — and no `hasDirectory` prop either: the hub view is a projection
 * that does not carry `storageDirectoryId`, so a client-side "is there a directory"
 * would be a guess that goes stale. The server's 409 says it plainly instead.
 */

export interface OrganizeReviewFile {
  fileId: string;
  fileName: string;
  episodeCode?: string;
  seasonNumber?: number;
  reason?: string;
  suggestedSeasonNumber?: number;
  suggestedEpisodeCode?: string;
}

export type OrganizePanelState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "organized"; copy: string; moves: OrganizeReviewFile[] }
  | {
      kind: "manual_review";
      copy: string;
      placeable: OrganizeReviewFile[];
      unresolved: OrganizeReviewFile[];
    }
  | { kind: "stopped"; copy: string; status: number };

/**
 * Map a response onto the panel's state. A pure function so the four outcomes are
 * testable without a fetch — inlined in an event handler, only a copy could be tested.
 *
 * 409 is the important one: it means the drive did NOT confirm the plan, so the panel
 * says so rather than showing a progress bar that would eventually claim success.
 */
export function mapOrganizeResponse(
  status: number,
  body: unknown,
): OrganizePanelState {
  const parsed = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const copy = typeof parsed["copy"] === "string" ? (parsed["copy"] as string) : "";

  if (status === 200 && parsed["status"] === "organized") {
    const moves = Array.isArray(parsed["moves"]) ? (parsed["moves"] as OrganizeReviewFile[]) : [];
    return { kind: "organized", copy, moves };
  }
  if (status === 200 && parsed["status"] === "manual_review") {
    const review = (parsed["review"] ?? {}) as Record<string, unknown>;
    return {
      kind: "manual_review",
      copy,
      placeable: Array.isArray(review["placeable"])
        ? (review["placeable"] as OrganizeReviewFile[])
        : [],
      unresolved: Array.isArray(review["unresolved"])
        ? (review["unresolved"] as OrganizeReviewFile[])
        : [],
    };
  }
  // 409 (drift / no directory / no storage) and anything unexpected: the run stopped.
  return { kind: "stopped", copy, status };
}

/** Why a file could not be placed, in the user's words. */
export function unresolvedReasonCopy(file: OrganizeReviewFile): string {
  switch (file.reason) {
    case "no_episode_code":
      return "文件名里没有集号";
    case "ambiguous_season":
      return "无法确定是哪一季";
    case "duplicate_episode_code":
      return "与另一个文件争同一集";
    default:
      return "无法自动放置";
  }
}

export interface OrganizePanelProps {
  tmdbId: number;
  /** Omitted for a movie, whose directory carries no season. */
  seasonNumber: number | undefined;
}

export function OrganizePanel({ tmdbId, seasonNumber }: OrganizePanelProps) {
  const [state, setState] = useState<OrganizePanelState>({ kind: "idle" });
  const router = useRouter();

  const organize = useCallback(async () => {
    setState({ kind: "submitting" });
    try {
      const response = await fetch("/api/titles/organize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          seasonNumber === undefined ? { tmdbId } : { tmdbId, seasonNumber },
        ),
      });
      const body: unknown = await response.json().catch(() => null);
      setState(mapOrganizeResponse(response.status, body));
      // A run was persisted (organized or review), so the title's own state may have
      // moved. Refresh from the server rather than patching the DOM by hand.
      router.refresh();
    } catch {
      setState({ kind: "stopped", copy: "网络错误，整理未执行", status: 0 });
    }
  }, [router, seasonNumber, tmdbId]);

  return (
    <section className="title-organize" aria-label="自动整理">
      <div className="title-organize-head">
        <h2>整理</h2>
        <button
          type="button"
          className="title-organize-run"
          onClick={organize}
          disabled={state.kind === "submitting"}
        >
          {state.kind === "submitting" ? "整理中…" : "整理此目录"}
        </button>
      </div>

      {state.kind === "organized" ? (
        <div className="title-organize-result">
          <p className="title-organize-copy">{state.copy}</p>
          <ul className="title-organize-list">
            {state.moves.map((move) => (
              <li key={move.fileId} className="title-organize-item">
                <span className="title-organize-item-title">{move.fileName}</span>
                <span className="title-organize-item-meta">
                  {move.episodeCode ?? "—"}
                  {move.seasonNumber === undefined ? "" : ` · 第 ${move.seasonNumber} 季`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {state.kind === "manual_review" ? (
        <div className="title-organize-review">
          <p className="title-organize-copy">{state.copy}</p>
          {state.unresolved.length > 0 ? (
            <>
              <h3 className="title-organize-subhead">需要你确认</h3>
              <ul className="title-organize-list">
                {state.unresolved.map((file) => (
                  <li key={file.fileId} className="title-organize-item title-organize-item-blocked">
                    <span className="title-organize-item-title">{file.fileName}</span>
                    <span className="title-organize-item-meta">{unresolvedReasonCopy(file)}</span>
                    {file.suggestedEpisodeCode === undefined ? null : (
                      <span className="title-organize-item-suggest">
                        建议集号 {file.suggestedEpisodeCode}
                        {file.suggestedSeasonNumber === undefined
                          ? ""
                          : ` · 建议第 ${file.suggestedSeasonNumber} 季`}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {state.placeable.length > 0 ? (
            <>
              <h3 className="title-organize-subhead">可直接放置</h3>
              <ul className="title-organize-list">
                {state.placeable.map((move) => (
                  <li key={move.fileId} className="title-organize-item">
                    <span className="title-organize-item-title">{move.fileName}</span>
                    <span className="title-organize-item-meta">
                      {move.episodeCode ?? "—"}
                      {move.seasonNumber === undefined ? "" : ` · 第 ${move.seasonNumber} 季`}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      {state.kind === "stopped" ? (
        <p className="title-organize-stopped">
          {state.copy === "" ? "整理未执行" : state.copy}
          {state.status === 409 ? "（已停止，未做任何改动）" : ""}
        </p>
      ) : null}
    </section>
  );
}
