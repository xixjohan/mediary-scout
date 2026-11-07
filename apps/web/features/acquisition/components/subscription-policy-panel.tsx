"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SeasonEpisodeRangesSection } from "./subscription-modal-fields";
import {
  createPolicyPriorityGroupDraft,
  draftToPolicy,
  mapSavedPolicy,
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
  mediaType: "movie" | "tv";
  seasonNumbers?: number[];
}

function appendFilterChip(current: string, chip: string): string {
  const trimmed = current.trim();
  const token = chip.trim();
  if (!token) return current;
  if (!trimmed) return token;
  const tokens = trimmed.split(/[,，\s]+/);
  if (tokens.some((t) => t.toLowerCase() === token.toLowerCase())) {
    return trimmed;
  }
  return `${trimmed}, ${token}`;
}

const CONTAIN_PRESETS = ["2160p", "1080p", "简日内嵌", "简中字幕"] as const;
const EXCLUDE_PRESETS = ["CAM/枪版", "预告片", "国语配音"] as const;

type PolicyTemplate = { id: string; name: string; policy: unknown };

async function parsePolicyTemplateResponse(response: Response, fallback: string): Promise<{ template: PolicyTemplate | null; error: string }> {
  const body: unknown = await response.json().catch(() => null);
  const candidate = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["template"] : null;
  if (response.ok && typeof candidate === "object" && candidate !== null) {
    return { template: candidate as PolicyTemplate, error: "" };
  }
  const error = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["error"] : null;
  return { template: null, error: typeof error === "string" ? error : fallback };
}

export function SubscriptionPolicyPanel({ tmdbId, mediaType, seasonNumbers = [] }: SubscriptionPolicyPanelProps) {
  const [draft, setDraft] = useState<PolicyDraft>({
    mustContain: "",
    mustNotContain: "",
    episodeFilter: "",
    useRegex: false,
    cooldownDays: 0,
    customKeywords: "",
    priorityGroups: [],
    seasonEpisodeRanges: [],
  });
  const [state, setState] = useState<PolicyPanelState>({ kind: "idle" });
  const [saved, setSaved] = useState<PolicyDraft | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
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
    fetch(`/api/titles/subscription-policy?tmdbId=${tmdbId}&mediaType=${mediaType}`)
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
  }, [tmdbId, mediaType]);

  const applyTemplateDraft = useCallback((loaded: PolicyDraft) => {
    touchedRef.current = true;
    setDraft(loaded);
    setIsExpanded(true);
  }, []);

  const preview = useCallback(async () => {
    // 预览同样依赖当前表单：读回在飞时预览过，表单就不能再被旧值替换，
    // 否则屏幕上会出现「表单是旧规则、预览结果是新规则」的错位画面
    touchedRef.current = true;
    setState({ kind: "previewing" });
    try {
      const response = await fetch("/api/titles/subscription-policy/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tmdbId, mediaType, policy: draftToPolicy(draft) }),
      });
      const body: unknown = await response.json().catch(() => null);
      setState(mapPreviewResponse(response.status, body));
    } catch {
      setState({ kind: "failed", copy: "网络错误，预览未执行" });
    }
  }, [draft, mediaType, tmdbId]);

  const save = useCallback(async () => {
    // 保存即「用户动过」：迟到的挂载读回不许把刚存的新规则擦回旧值
    touchedRef.current = true;
    setState({ kind: "saving" });
    try {
      const response = await fetch("/api/titles/subscription-policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tmdbId, mediaType, policy: draftToPolicy(draft) }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        setSaved(draft);
        setIsExpanded(false);
        setState({ kind: "saved", copy: "已保存" });
        router.refresh();
        return;
      }
      setState(mapSaveResponse(response.status, body));
    } catch {
      setState({ kind: "failed", copy: "网络错误，策略未保存" });
    }
  }, [draft, mediaType, router, tmdbId]);

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
        <div className="sub-policy-head-side">
          {saved === null ? (
            <span className="sub-policy-unset">还没配规则</span>
          ) : (
            <span className="sub-policy-set">已配规则</span>
          )}
          {saved !== null ? (
            <button
              type="button"
              className="sub-policy-toggle-btn"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              {isExpanded ? "收起" : "修改规则"}
            </button>
          ) : null}
        </div>
      </div>

      {saved !== null && !isExpanded ? (
        <PolicyCollapsedSummary saved={saved} onExpand={() => setIsExpanded(true)} />
      ) : (
        <>
          <SubscriptionPolicyTemplateTools draft={draft} onApply={applyTemplateDraft} />
          <PolicyFields draft={draft} update={update} seasonNumbers={seasonNumbers} />

          <div className="sub-policy-actions">
            <button type="button" onClick={preview} disabled={state.kind === "previewing"}>
              {state.kind === "previewing" ? "预览中…" : "预览效果"}
            </button>
            <button type="button" onClick={save} disabled={state.kind === "saving"}>
              {state.kind === "saving" ? "保存中…" : "保存"}
            </button>
            {saved !== null ? (
              <button type="button" onClick={() => setIsExpanded(false)}>
                收起
              </button>
            ) : null}
          </div>
        </>
      )}

      {state.kind === "previewed" ? (
        <PolicyPreviewSection state={state} nothingMatches={nothingMatches} />
      ) : null}

      {/* 三态分色：保存是绿，拒绝/失败是红——被 API 拒绝的保存绝不能看起来像成功。 */}
      {state.kind === "saved" ? <p className="sub-policy-copy is-ok">{state.copy}</p> : null}
      {state.kind === "rejected" ? <p className="sub-policy-copy is-bad">{state.copy}</p> : null}
      {state.kind === "failed" ? <p className="sub-policy-copy is-bad">{state.copy}</p> : null}
    </section>
  );
}

function SubscriptionPolicyTemplateTools({ draft, onApply }: { draft: PolicyDraft; onApply: (loaded: PolicyDraft) => void }) {
  const [templates, setTemplates] = useState<PolicyTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templateMessage, setTemplateMessage] = useState("");
  const [templateAction, setTemplateAction] = useState<"save" | "update" | "delete" | null>(null);
  const busy = templateAction !== null;

  useEffect(() => {
    let alive = true;
    fetch("/api/titles/subscription-policy/templates")
      .then((response) => response.json())
      .then((body: unknown) => {
        if (!alive || typeof body !== "object" || body === null || !Array.isArray((body as Record<string, unknown>)["templates"])) return;
        setTemplates((body as { templates: PolicyTemplate[] }).templates);
      })
      .catch(() => { if (alive) setTemplateMessage("模板列表暂时不可用"); });
    return () => { alive = false; };
  }, []);

  const applyTemplate = () => {
    const template = templates.find((item) => item.id === selectedTemplateId);
    const loaded = template ? mapSavedPolicy(template.policy) : null;
    if (!template || !loaded) {
      setTemplateMessage("模板内容无法读取");
      return;
    }
    onApply(loaded);
    setTemplateMessage(`已套用「${template.name}」，保存策略后才会生效`);
  };

  const saveTemplate = async () => {
    const name = templateName.trim();
    if (busy) return;
    if (!name) { setTemplateMessage("请先填写模板名称"); return; }
    setTemplateAction("save");
    try {
      const response = await fetch("/api/titles/subscription-policy/templates", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, policy: draftToPolicy(draft) }),
      });
      const result = await parsePolicyTemplateResponse(response, "模板保存失败");
      if (!result.template) { setTemplateMessage(result.error); return; }
      setTemplates((current) => [...current.filter((item) => item.id !== result.template!.id), result.template!]);
      setSelectedTemplateId(result.template.id);
      setTemplateName("");
      setTemplateMessage("模板已保存");
    } catch { setTemplateMessage("网络错误，模板未保存"); }
    finally { setTemplateAction(null); }
  };

  const updateTemplate = async () => {
    const name = templateName.trim();
    if (!selectedTemplateId || busy) return;
    if (!name) { setTemplateMessage("请填写模板名称"); return; }
    setTemplateAction("update");
    try {
      const response = await fetch("/api/titles/subscription-policy/templates", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: selectedTemplateId, name, policy: draftToPolicy(draft) }),
      });
      const result = await parsePolicyTemplateResponse(response, "模板更新失败");
      if (!result.template) { setTemplateMessage(result.error); return; }
      setTemplates((current) => [...current.filter((item) => item.id !== result.template!.id), result.template!]);
      setSelectedTemplateId(result.template.id);
      setTemplateMessage("模板已更新；已应用到作品的规则和排队任务不受影响");
    } catch { setTemplateMessage("网络错误，模板未更新"); }
    finally { setTemplateAction(null); }
  };

  const deleteTemplate = async () => {
    if (!selectedTemplateId || busy) return;
    setTemplateAction("delete");
    try {
      const response = await fetch("/api/titles/subscription-policy/templates", {
        method: "DELETE", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: selectedTemplateId }),
      });
      if (!response.ok) { setTemplateMessage("模板删除失败"); return; }
      setTemplates((current) => current.filter((item) => item.id !== selectedTemplateId));
      setSelectedTemplateId("");
      setTemplateName("");
      setTemplateMessage("模板已删除；已应用到作品的规则不受影响");
    } catch { setTemplateMessage("网络错误，模板未删除"); }
    finally { setTemplateAction(null); }
  };

  return (
    <div className="sub-policy-template-tools" aria-label="订阅策略模板">
      <label>模板
        <select value={selectedTemplateId} disabled={busy} onChange={(event) => {
          const id = event.target.value;
          setSelectedTemplateId(id);
          setTemplateName(templates.find((item) => item.id === id)?.name ?? "");
          setTemplateMessage("");
        }}>
          <option value="">选择已保存模板</option>
          {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
        </select>
      </label>
      <div className="sub-policy-template-actions">
        <button type="button" disabled={!selectedTemplateId || busy} onClick={applyTemplate}>应用模板</button>
        <button type="button" disabled={!selectedTemplateId || busy} onClick={updateTemplate}>{templateAction === "update" ? "更新中…" : "用当前规则更新模板"}</button>
        <button type="button" disabled={!selectedTemplateId || busy} onClick={deleteTemplate}>{templateAction === "delete" ? "删除中…" : "删除模板"}</button>
      </div>
      <label>另存为模板
        <input value={templateName} maxLength={40} onChange={(event) => setTemplateName(event.target.value)} placeholder="例如：动漫 1080p 字幕组" />
      </label>
      <button type="button" disabled={busy} onClick={saveTemplate}>{templateAction === "save" ? "保存中…" : "保存当前规则为模板"}</button>
      {templateMessage ? <p role="status">{templateMessage}</p> : null}
    </div>
  );
}

function PolicyCollapsedSummary({
  saved,
  onExpand,
}: {
  saved: PolicyDraft;
  onExpand: () => void;
}) {
  return (
    <div className="sub-policy-collapsed-summary">
      <div className="sub-policy-summary-tags">
        <span className="sub-policy-summary-tag">包含：{saved.mustContain || "未限"}</span>
        <span className="sub-policy-summary-tag">排除：{saved.mustNotContain || "未限"}</span>
        <span className="sub-policy-summary-tag">集数：{saved.episodeFilter || "全部"}</span>
        <span className="sub-policy-summary-tag">逐季范围：{saved.seasonEpisodeRanges?.length ? `${saved.seasonEpisodeRanges.length} 季已设置` : "未单独限制"}</span>
        <span className="sub-policy-summary-tag">冷却：{saved.cooldownDays}天</span>
        <span className="sub-policy-summary-tag">优先级组：{saved.priorityGroups?.length ?? 0}组</span>
      </div>
      <button type="button" className="sub-policy-toggle-btn" onClick={onExpand}>
        修改规则
      </button>
    </div>
  );
}

function PolicyFields({
  draft,
  update,
  seasonNumbers,
}: {
  draft: PolicyDraft;
  update: (patch: Partial<PolicyDraft>) => void;
  seasonNumbers: number[];
}) {
  return (
    <div className="sub-policy-fields">
      <label>
        必须包含
        <input
          value={draft.mustContain}
          onChange={(event) => update({ mustContain: event.target.value })}
          placeholder="2160p, 简中"
        />
        <span className="sub-policy-chips">
          {CONTAIN_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className="sub-policy-chip"
              onClick={() => update({ mustContain: appendFilterChip(draft.mustContain, preset) })}
            >
              + {preset}
            </button>
          ))}
        </span>
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
        <span className="sub-policy-chips">
          {EXCLUDE_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className="sub-policy-chip"
              onClick={() => update({ mustNotContain: appendFilterChip(draft.mustNotContain, preset) })}
            >
              + {preset}
            </button>
          ))}
        </span>
      </label>
      <label>
        集数范围
        <input
          value={draft.episodeFilter}
          onChange={(event) => update({ episodeFilter: event.target.value })}
          placeholder="S01-S03;E01-E10"
        />
      </label>
      {seasonNumbers.length > 0 ? (
        <SeasonEpisodeRangesSection
          seasonNumbers={seasonNumbers}
          ranges={draft.seasonEpisodeRanges ?? []}
          onChange={(seasonEpisodeRanges) => update({ seasonEpisodeRanges })}
        />
      ) : null}
      <label>
        <span>
          冷却天数 <span className="sub-policy-field-help">（失败后暂缓重试天数）</span>
        </span>
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
      <section aria-label="优先级组" className="sub-policy-priority-groups">
        <div className="sub-policy-priority-heading">
          <strong>优先级组</strong>
          <span>从上到下匹配；空白组会跳过，配置优先级组后，未命中候选会被排除。</span>
        </div>
        {(draft.priorityGroups ?? []).map((group, index) => (
          <fieldset key={group.id} className="sub-policy-priority-group">
            <legend>第 {index + 1} 组</legend>
            <label>组名<input value={group.name} maxLength={40} onChange={(event) => updatePriorityGroup(draft, update, index, { name: event.target.value })} /></label>
            <label>必须包含<input value={group.mustContain} placeholder="REMUX, 2160p" onChange={(event) => updatePriorityGroup(draft, update, index, { mustContain: event.target.value })} /></label>
            <label>组内排除<input value={group.mustNotContain} placeholder="杜比视界" onChange={(event) => updatePriorityGroup(draft, update, index, { mustNotContain: event.target.value })} /></label>
            <div className="sub-policy-priority-actions">
              <button type="button" disabled={index === 0} onClick={() => movePriorityGroup(draft, update, index, -1)}>上移</button>
              <button type="button" disabled={index === (draft.priorityGroups?.length ?? 0) - 1} onClick={() => movePriorityGroup(draft, update, index, 1)}>下移</button>
              <button type="button" onClick={() => update({ priorityGroups: (draft.priorityGroups ?? []).filter((_, i) => i !== index) })}>删除</button>
            </div>
          </fieldset>
        ))}
        <button type="button" disabled={(draft.priorityGroups?.length ?? 0) >= 8} onClick={() => update({ priorityGroups: [...(draft.priorityGroups ?? []), createPolicyPriorityGroupDraft()] })}>添加优先级组</button>
      </section>
    </div>
  );
}

function updatePriorityGroup(draft: PolicyDraft, update: (patch: Partial<PolicyDraft>) => void, index: number, patch: Partial<NonNullable<PolicyDraft["priorityGroups"]>[number]>) {
  update({ priorityGroups: (draft.priorityGroups ?? []).map((group, i) => i === index ? { ...group, ...patch } : group) });
}

function movePriorityGroup(draft: PolicyDraft, update: (patch: Partial<PolicyDraft>) => void, index: number, delta: -1 | 1) {
  const groups = [...(draft.priorityGroups ?? [])];
  const target = index + delta;
  if (target < 0 || target >= groups.length) return;
  [groups[index], groups[target]] = [groups[target]!, groups[index]!];
  update({ priorityGroups: groups });
}

function PolicyPreviewSection({
  state,
  nothingMatches,
}: {
  state: Extract<PolicyPanelState, { kind: "previewed" }>;
  nothingMatches: boolean;
}) {
  return (
    <div className="sub-policy-preview">
      <p className="sub-policy-headline">{previewHeadlineCopy(state.outcome)}</p>
      {nothingMatches ? (
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
  );
}

/** A save that the API refused: show what it said, do not fall back to "saved". */
function mapSaveResponse(status: number, body: unknown): PolicyPanelState {
  const parsed = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const copy = typeof parsed["error"] === "string" ? (parsed["error"] as string) : "保存失败";
  return { kind: "rejected", copy, status };
}

