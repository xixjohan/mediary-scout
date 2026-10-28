"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  draftToPolicy,
  mapPolicyLoadResponse,
  mapPreviewResponse,
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
    customKeywords: "",
  });
  const [state, setState] = useState<PolicyPanelState>({ kind: "idle" });
  const [saved, setSaved] = useState<PolicyDraft | null>(null);
  const router = useRouter();

  /**
   * 用户是否已经在挂载后动过这个表单（改字段或保存）。
   *
   * 挂载即读回（下面的 effect）是一次异步竞态：GET 在飞的时候用户完全可能已经
   * 开始打字，甚至已经保存了一条新规则。若不看这个标记就无条件 setDraft，
   * 迟到的那次读回会把用户刚写的内容擦成旧值——正是「刷新丢策略」的镜像 bug。
   * 用户一动过，这次读回就作废：表单以用户看到的内容为准。
   */
  const touchedRef = useRef(false);
  const update = useCallback((patch: Partial<PolicyDraft>) => {
    touchedRef.current = true;
    setDraft((prev) => ({ ...prev, ...patch }));
  }, []);

  /**
   * 挂载即读回已保存的策略。
   *
   * 修的是一个真 bug：GET 端点和 mapSavedPolicy 都在、都被测过，但面板从不调用——
   * 刷新页面后表单永远空白、标题永远说「还没配规则」，用户存过的规则从眼前消失。
   * 读失败（404 未追踪 / 5xx / 坏形状）一律降级成 null：空表单 + 「还没配规则」
   * 正是没配过规则该有的样子，配规则这个动作不依赖读成功。
   */
  useEffect(() => {
    let alive = true;
    fetch(`/api/titles/subscription-policy?tmdbId=${tmdbId}`)
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        return mapPolicyLoadResponse(response.status, body);
      })
      .then((loaded) => {
        // 用户在读回在飞期间动了表单/存了规则 ⇒ 这次读回已过期，别擦掉人家刚写的
        if (!alive || touchedRef.current) return;
        if (loaded === null) return;
        setDraft(loaded);
        setSaved(loaded);
      })
      .catch(() => {
        // 网络错误：表单留空，用户照样能现配一条
      });
    return () => {
      alive = false;
    };
  }, [tmdbId]);

  const preview = useCallback(async () => {
    // 预览同样依赖当前表单：读回在飞时预览过，表单就不能再被旧值替换，
    // 否则屏幕上会出现「表单是旧规则、预览结果是新规则」的错位画面
    touchedRef.current = true;
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
    // 保存即「用户动过」：迟到的挂载读回不许把刚存的新规则擦回旧值
    touchedRef.current = true;
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
    <section className="hub-panel sub-policy" aria-label="订阅策略">
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
            onChange={(event) => update({ mustContain: event.target.value })}
            placeholder="2160p, 简中"
          />
        </label>
        <label>
          自定义搜索词
          <input
            value={draft.customKeywords ?? ""}
            onChange={(event) => update({ customKeywords: event.target.value })}
            placeholder="4K, 喵萌奶茶屋"
          />
        </label>
        <label>
          必须排除
          <input
            value={draft.mustNotContain}
            onChange={(event) => update({ mustNotContain: event.target.value })}
            placeholder="CAM, 枪版"
          />
        </label>
        <label>
          集数范围
          <input
            value={draft.episodeFilter}
            onChange={(event) => update({ episodeFilter: event.target.value })}
            placeholder="S01-S03;E01-E10"
          />
        </label>
        <label>
          冷却天数
          <input
            type="number"
            min={0}
            value={draft.cooldownDays}
            onChange={(event) => update({ cooldownDays: Number(event.target.value) })}
          />
        </label>
        <label className="sub-policy-regex">
          <input
            type="checkbox"
            checked={draft.useRegex}
            onChange={(event) => update({ useRegex: event.target.checked })}
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
          {state.outcome.matched.length > 0 ? (
            <>
              <p className="sub-policy-sublist-label">命中 {state.outcome.matched.length} 个</p>
              <ul className="sub-policy-matched">
                {state.outcome.matched.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </>
          ) : null}
          {state.outcome.excluded.length > 0 ? (
            <>
              <p className="sub-policy-sublist-label">排除 {state.outcome.excluded.length} 个</p>
              <ul className="sub-policy-excluded">
                {state.outcome.excluded.map((entry) => (
                  <li key={entry.name}>
                    {entry.name}
                    <span className="sub-policy-reason">{previewReasonCopy(entry.reason)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      {/* 三态分色：保存是绿，拒绝/失败是红——被 API 拒绝的保存绝不能看起来像成功。 */}
      {state.kind === "saved" ? <p className="sub-policy-copy is-ok">{state.copy}</p> : null}
      {state.kind === "rejected" ? <p className="sub-policy-copy is-bad">{state.copy}</p> : null}
      {state.kind === "failed" ? <p className="sub-policy-copy is-bad">{state.copy}</p> : null}
    </section>
  );
}

/** A save that the API refused: show what it said, do not fall back to "saved". */
function mapSaveResponse(status: number, body: unknown): PolicyPanelState {
  const parsed = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const copy = typeof parsed["error"] === "string" ? (parsed["error"] as string) : "保存失败";
  return { kind: "rejected", copy, status };
}

