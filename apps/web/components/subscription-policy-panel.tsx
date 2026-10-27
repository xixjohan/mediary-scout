"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import {
  draftToPolicy,
  mapPreviewResponse,
  mapSavedPolicy,
  previewHeadlineCopy,
  previewReasonCopy,
  ruleExcludesEverything,
  type PolicyDraft,
  type PolicyPanelState,
  type PreviewOutcome,
} from "./subscription-policy-panel-model";

/**
 * 订阅策略面板 (batch 5, plan §4.1).
 *
 * The plan calls the rule preview "low cost, high value" because of what it lets the user
 * do: tune a rule by its *effect* instead of by its text. This panel is that loop —
 * type a rule, see 「命中 N 个 / 排除 M 个」 immediately, save when the numbers are what
 * they wanted. A rule whose effect only shows up at the next patrol is a rule nobody can
 * tune, which is why the preview sits next to the fields rather than behind a separate
 * page.
 *
 * The mapping from response to panel state is a pure function
 * (`subscription-policy-panel-model.ts`) so the outcomes are testable without a fetch.
 * Inlined in a handler, only a copy could be tested — and the copy is the part that tells
 * the user whether their rule is doing anything.
 */

export interface SubscriptionPolicyPanelProps {
  tmdbId: number;
}

export function SubscriptionPolicyPanel({ tmdbId }: SubscriptionPolicyPanelProps) {
  const [draft, setDraft] = useState<PolicyDraft>({
    mustContain: "",
    mustNotContain: "",
    episodeFilter: "",
    useRegex: false,
    cooldownDays: 0,
  });
  const [state, setState] = useState<PolicyPanelState>({ kind: "idle" });
  const [saved, setSaved] = useState<PolicyDraft | null>(null);
  const router = useRouter();

  const preview = useCallback(async () => {
    setState({ kind: "previewing" });
    try {
      const response = await fetch("/api/titles/subscription-policy/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tmdbId, policy: draftToPolicy(draft) }),
      });
      const body: unknown = await response.json().catch(() => null);
      setState(mapPreviewResponse(response.status, body));
    } catch {
      setState({ kind: "failed", copy: "网络错误，预览未执行" });
    }
  }, [draft, tmdbId]);

  const save = useCallback(async () => {
    setState({ kind: "saving" });
    try {
      const response = await fetch("/api/titles/subscription-policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tmdbId, policy: draftToPolicy(draft) }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        setSaved(draft);
        setState({ kind: "saved", copy: "已保存" });
        router.refresh();
        return;
      }
      setState(mapSaveResponse(response.status, body));
    } catch {
      setState({ kind: "failed", copy: "网络错误，策略未保存" });
    }
  }, [draft, router, tmdbId]);

  // A rule that would exclude everything is worth saying out loud before it is saved:
  // "命中 0 个" from an empty search and "命中 0 个" from a rule that filters everything
  // look identical on screen, and only the second one is the user's mistake. Uses the
  // tested pure predicate, not an inline copy of its condition.
  const nothingMatches =
    state.kind === "previewed" && ruleExcludesEverything(state.outcome);

  return (
    <section className="sub-policy" aria-label="订阅策略">
      <div className="sub-policy-head">
        <h2>订阅策略</h2>
        {saved === null ? (
          <span className="sub-policy-unset">还没配规则</span>
        ) : (
          <span className="sub-policy-set">已配规则</span>
        )}
      </div>

      <div className="sub-policy-fields">
        <label>
          必须包含
          <input
            value={draft.mustContain}
            onChange={(event) => setDraft({ ...draft, mustContain: event.target.value })}
            placeholder="2160p, 简中"
          />
        </label>
        <label>
          必须排除
          <input
            value={draft.mustNotContain}
            onChange={(event) => setDraft({ ...draft, mustNotContain: event.target.value })}
            placeholder="CAM, 枪版"
          />
        </label>
        <label>
          集数范围
          <input
            value={draft.episodeFilter}
            onChange={(event) => setDraft({ ...draft, episodeFilter: event.target.value })}
            placeholder="S01-S03;E01-E10"
          />
        </label>
        <label>
          冷却天数
          <input
            type="number"
            min={0}
            value={draft.cooldownDays}
            onChange={(event) => setDraft({ ...draft, cooldownDays: Number(event.target.value) })}
          />
        </label>
        <label className="sub-policy-regex">
          <input
            type="checkbox"
            checked={draft.useRegex}
            onChange={(event) => setDraft({ ...draft, useRegex: event.target.checked })}
          />
          用正则
        </label>
      </div>

      <div className="sub-policy-actions">
        <button type="button" onClick={preview} disabled={state.kind === "previewing"}>
          {state.kind === "previewing" ? "预览中…" : "预览效果"}
        </button>
        <button type="button" onClick={save} disabled={state.kind === "saving"}>
          {state.kind === "saving" ? "保存中…" : "保存"}
        </button>
      </div>

      {state.kind === "previewed" ? (
        <div className="sub-policy-preview">
          <p className="sub-policy-headline">{previewHeadlineCopy(state.outcome)}</p>
          {nothingMatches ? (
            // The one case where the numbers mean the user's rule, not the search.
            <p className="sub-policy-warn">这条规则排除了全部候选——检查一下是不是写得太严</p>
          ) : null}
          <ul className="sub-policy-matched">
            {state.outcome.matched.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          <ul className="sub-policy-excluded">
            {state.outcome.excluded.map((entry) => (
              <li key={entry.name}>
                {entry.name}
                <span className="sub-policy-reason">{previewReasonCopy(entry.reason)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {state.kind === "saved" ? <p className="sub-policy-copy">{state.copy}</p> : null}
      {state.kind === "rejected" ? <p className="sub-policy-copy">{state.copy}</p> : null}
      {state.kind === "failed" ? <p className="sub-policy-copy">{state.copy}</p> : null}
    </section>
  );
}

/** A save that the API refused: show what it said, do not fall back to "saved". */
function mapSaveResponse(status: number, body: unknown): PolicyPanelState {
  const parsed = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const copy = typeof parsed["error"] === "string" ? (parsed["error"] as string) : "保存失败";
  return { kind: "rejected", copy, status };
}

