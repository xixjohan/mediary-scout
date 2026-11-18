"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SeasonEpisodeRangesSection } from "./subscription-modal-fields";
import { PolicyTemplateTools } from "./policy-template-tools";
import {
  PRESETS,
  createBlankDraft,
  draftToPolicy,
  makePriorityGroup,
  mapPolicyLoadResponse,
  mapSavedPolicy,
  splitTerms,
  toggleTerm,
  validateDraft,
  type PolicyDraft,
  type PresetKind,
} from "../core/policy-draft";
import { useResourceCooldown } from "../hooks/use-resource-cooldown";
import {
  mapPreviewResponse,
  previewHeadlineCopy,
  previewReasonCopy,
  ruleExcludesEverything,
  diagnoseEmptyPreview,
  type PreviewOutcome,
} from "../core/policy-preview";

/**
 * 订阅策略面板（作品详情页）。
 *
 * 与「创建订阅」向导共用同一套核心：草稿 ⇄ 线上形状的转换在 `core/policy-draft.ts`，
 * 模板 CRUD 在 `PolicyTemplateTools`。之前这里是这两个能力的第二份手写实现，
 * 于是两端行为各自漂移（默认值不同、切分规则不同、模板入口只在一边）。
 *
 * 读回与预览仍然带 `touchedRef`：挂载时的 GET 与预览请求都在飞的时候用户完全
 * 可能已经在打字，迟到的响应不许擦掉或覆盖用户刚写的内容。
 */

export interface SubscriptionPolicyPanelProps {
  tmdbId: number;
  mediaType: "movie" | "tv" | "anime";
  seasonNumbers?: number[];
}

const CONTAIN_PRESETS = ["2160p", "1080p", "简日内嵌", "Remux", "HDR"] as const;
const EXCLUDE_PRESETS = ["CAM/枪版", "预告片", "国语配音"] as const;

export function SubscriptionPolicyPanel({ tmdbId, mediaType, seasonNumbers = [] }: SubscriptionPolicyPanelProps) {
  const [draft, setDraft] = useState<PolicyDraft>(() => emptyDraft());
  const [saved, setSaved] = useState<PolicyDraft | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [preview, setPreview] = useState<PreviewOutcome | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [throttleMs, setThrottleMs] = useState(0);
  const [saving, setSaving] = useState(false);
  const [copy, setCopy] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const router = useRouter();
  const touchedRef = useRef(false);

  const update = useCallback((patch: Partial<PolicyDraft>) => {
    touchedRef.current = true;
    setDraft((prev) => ({ ...prev, ...patch }));
    setPreview(null);
    setPreviewError(null);
  }, []);

  useEffect(() => {
    let alive = true;
    fetch(`/api/titles/subscription-policy?tmdbId=${tmdbId}&mediaType=${mediaType}`)
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        return mapPolicyLoadResponse(response.status, body);
      })
      .then((loaded) => {
        if (!alive || touchedRef.current || loaded === null) return;
        setDraft(loaded);
        setSaved(loaded);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [tmdbId, mediaType]);

  const applyLoaded = useCallback((loaded: PolicyDraft) => {
    touchedRef.current = true;
    setDraft(loaded);
    setIsExpanded(true);
    setPreview(null);
  }, []);

  const previewPolicyDraft = useCallback(async () => {
    const issues = validateDraft(draft);
    if (issues.length > 0) {
      setCopy({ tone: "bad", text: issues[0]!.message });
      return;
    }
    touchedRef.current = true;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const response = await fetch("/api/titles/subscription-policy/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tmdbId, mediaType, seasonNumbers, policy: draftToPolicy(draft) }),
      });
      const body: unknown = await response.json().catch(() => null);
      const mapped = mapPreviewResponse(response.status, body);
      if (mapped.ok) {
        setPreview(mapped.outcome);
        setCopy(null);
        setThrottleMs(0);
      } else {
        // 429 不是「规则有问题」：把剩余秒数交给倒计时，按钮在该窗口内禁用。
        setPreviewError(mapped.copy);
        setThrottleMs(mapped.retryAfterMs ?? 0);
      }
    } catch {
      setPreviewError("网络错误，预览未执行");
    } finally {
      setPreviewing(false);
    }
  }, [draft, mediaType, seasonNumbers, tmdbId]);

  const save = useCallback(async () => {
    const issues = validateDraft(draft);
    if (issues.length > 0) {
      setCopy({ tone: "bad", text: issues[0]!.message });
      return;
    }
    touchedRef.current = true;
    setSaving(true);
    setCopy(null);
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
        setCopy({ tone: "ok", text: "已保存；已排队的任务继续使用入队时的规则" });
        router.refresh();
        return;
      }
      const parsed = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      setCopy({ tone: "bad", text: typeof parsed["error"] === "string" ? (parsed["error"] as string) : "保存失败" });
    } catch {
      setCopy({ tone: "bad", text: "网络错误，策略未保存" });
    } finally {
      setSaving(false);
    }
  }, [draft, mediaType, router, tmdbId]);

  // 429 的倒计时：服务端已算出剩余的秒数，直接用它驱动按钮与提示，不猜。
  const cooldown = useResourceCooldown({
    retryAfterMs: throttleMs > 0 ? throttleMs : undefined,
    isThrottled: throttleMs > 0,
    busy: previewing,
    defaultButtonLabel: "预览效果",
    onRecover: () => setThrottleMs(0),
  });

  const diagnosis = useMemo(() => diagnoseFor(draft, preview), [draft, preview]);

  return (
    <PolicyPanelShell
      saved={saved}
      isExpanded={isExpanded}
      setIsExpanded={setIsExpanded}
      draft={draft}
      update={update}
      applyLoaded={applyLoaded}
      seasonNumbers={seasonNumbers}
      previewing={previewing}
      saving={saving}
      cooldown={cooldown}
      onPreview={() => void previewPolicyDraft()}
      onSave={() => void save()}
      preview={preview}
      diagnosis={diagnosis}
      previewError={previewError}
      copy={copy}
    />
  );
}

/** 面板骨架：把「渲染」从「状态与请求」里分出来，复杂度各自留在预算内。 */
function PolicyPanelShell(props: {
  saved: PolicyDraft | null;
  isExpanded: boolean;
  setIsExpanded: (value: boolean) => void;
  draft: PolicyDraft;
  update: (patch: Partial<PolicyDraft>) => void;
  applyLoaded: (loaded: PolicyDraft) => void;
  seasonNumbers: number[];
  previewing: boolean;
  saving: boolean;
  cooldown: { buttonText: string; isCooldownActive: boolean };
  onPreview: () => void;
  onSave: () => void;
  preview: PreviewOutcome | null;
  diagnosis: ReturnType<typeof diagnoseEmptyPreview>;
  previewError: string | null;
  copy: { tone: "ok" | "bad"; text: string } | null;
}) {
  return (
    <section className="hub-panel sub-policy" aria-label="订阅策略">
      <div className="sub-policy-head">
        <h2>订阅策略</h2>
        <div className="sub-policy-head-side">
          {props.saved === null ? <span className="sub-policy-unset">还没配规则</span> : <span className="sub-policy-set">已配规则</span>}
          {props.saved !== null ? (
            <button type="button" className="sub-policy-toggle-btn" onClick={() => props.setIsExpanded(!props.isExpanded)}>
              {props.isExpanded ? "收起" : "修改规则"}
            </button>
          ) : null}
        </div>
      </div>

      {props.saved !== null && !props.isExpanded ? (
        <PolicyCollapsedSummary saved={props.saved} onExpand={() => props.setIsExpanded(true)} />
      ) : (
        <>
          <div className="sub-policy-presets" aria-label="预设">
            {(Object.keys(PRESETS) as PresetKind[]).map((kind) => (
              <button
                key={kind}
                type="button"
                className="sub-policy-chip"
                title={PRESETS[kind].description}
                onClick={() => props.update({ ...PRESETS[kind].build(props.draft) })}
              >
                {PRESETS[kind].label}
              </button>
            ))}
          </div>
          <PolicyTemplateTools draft={props.draft} onApply={props.applyLoaded} toPolicy={draftToPolicy} />
          <PolicyFields draft={props.draft} update={props.update} seasonNumbers={props.seasonNumbers} />

          <div className="sub-policy-actions">
            <button type="button" onClick={props.onPreview} disabled={props.previewing || props.cooldown.isCooldownActive}>
              {props.previewing ? "预览中…" : props.cooldown.buttonText}
            </button>
            <button type="button" onClick={props.onSave} disabled={props.saving}>
              {props.saving ? "保存中…" : "保存"}
            </button>
            {props.saved !== null ? <button type="button" onClick={() => props.setIsExpanded(false)}>收起</button> : null}
          </div>
        </>
      )}

      {props.preview !== null ? <PolicyPreviewSection preview={props.preview} diagnosis={props.diagnosis} nothingMatches={ruleExcludesEverything(props.preview)} /> : null}
      {props.previewError !== null ? <p className="sub-policy-copy is-bad">{props.previewError}</p> : null}
      {props.copy !== null ? <p className={`sub-policy-copy ${props.copy.tone === "ok" ? "is-ok" : "is-bad"}`}>{props.copy.text}</p> : null}
    </section>
  );
}

function diagnoseFor(draft: PolicyDraft, preview: PreviewOutcome | null) {
  return preview === null ? null : diagnoseEmptyPreview({ outcome: preview, hasPriorityGroups: (draft.priorityGroups ?? []).length > 0 });
}

function emptyDraft(): PolicyDraft {
  return {
    ...createBlankDraft(),
    // 详情页面板从「还没配规则」开始：画质留空，字幕用共享默认词表（软偏好）。
    mustContain: "",
    mustNotContain: "",
  };
}

function PolicyCollapsedSummary({ saved, onExpand }: { saved: PolicyDraft; onExpand: () => void }) {
  return (
    <div className="sub-policy-collapsed-summary">
      <div className="sub-policy-summary-tags">
        <span className="sub-policy-summary-tag">包含：{saved.mustContain || "未限"}</span>
        <span className="sub-policy-summary-tag">排除：{saved.mustNotContain || "未限"}</span>
        <span className="sub-policy-summary-tag">字幕：{saved.subtitleRequire ? "必须中字" : "优先"}</span>
        <span className="sub-policy-summary-tag">集数：{saved.episodeFilter || "全部"}</span>
        <span className="sub-policy-summary-tag">逐季范围：{saved.seasonEpisodeRanges?.length ? `${saved.seasonEpisodeRanges.length} 季已设置` : "未单独限制"}</span>
        <span className="sub-policy-summary-tag">冷却：{saved.cooldownDays}天</span>
        <span className="sub-policy-summary-tag">优先级组：{saved.priorityGroups?.length ?? 0}组</span>
      </div>
      <button type="button" className="sub-policy-toggle-btn" onClick={onExpand}>修改规则</button>
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
          placeholder="2160p, 1080p"
        />
        <span className="sub-policy-chips">
          {CONTAIN_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className="sub-policy-chip"
              onClick={() => update({ mustContain: toggleTerm(draft.mustContain, preset, draft.useRegex) })}
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
              onClick={() => update({ mustNotContain: toggleTerm(draft.mustNotContain, preset, draft.useRegex) })}
            >
              + {preset}
            </button>
          ))}
        </span>
      </label>
      <label>
        <span>中文字幕</span>
        <input
          value={draft.subtitleTerms}
          onChange={(event) => update({ subtitleTerms: event.target.value })}
          placeholder="简中, CHS, 简繁, 双语, 中字, 内嵌"
        />
        <span className="sub-policy-chips">
          <label className="sub-policy-regex">
            <input
              type="checkbox"
              checked={draft.subtitleRequire}
              onChange={(event) => update({ subtitleRequire: event.target.checked })}
            />
            必须带中字（不勾选则字幕只做优选）
          </label>
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
          巡检冷却天数 <span className="sub-policy-field-help">（命中后 N 天内不再取新版本）</span>
        </span>
        <input
          type="number"
          min={0}
          value={draft.cooldownDays}
          onChange={(event) => update({ cooldownDays: Math.max(0, Number(event.target.value) || 0) })}
        />
      </label>
      <label className="sub-policy-regex">
        <input
          type="checkbox"
          checked={draft.useRegex}
          onChange={(event) => {
            // 切换语法时把当前词表按新语法重新拼回去，避免「正则模式的换行」掺进子串规则。
            const rejoin = (value: string) => splitTerms(value, draft.useRegex).join(event.target.checked ? "\n" : ", ");
            update({
              useRegex: event.target.checked,
              mustContain: rejoin(draft.mustContain),
              mustNotContain: rejoin(draft.mustNotContain),
            });
          }}
        />
        用正则（每行一个表达式）
      </label>
      <section aria-label="优先级组" className="sub-policy-priority-groups">
        <div className="sub-policy-priority-heading">
          <strong>优先级组</strong>
          <span>从上到下匹配；空白组会跳过，配置优先级组后，未命中任何组的候选会被过滤。</span>
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
            {group.mustContain.trim() === "" && group.mustNotContain.trim() === "" ? (
              <p className="sub-policy-field-help">空白组会被跳过，不参与匹配</p>
            ) : null}
          </fieldset>
        ))}
        <button
          type="button"
          disabled={(draft.priorityGroups?.length ?? 0) >= 8}
          onClick={() => update({ priorityGroups: [...(draft.priorityGroups ?? []), makePriorityGroup()] })}
        >
          添加优先级组
        </button>
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
  preview,
  diagnosis,
  nothingMatches,
}: {
  preview: PreviewOutcome;
  diagnosis: ReturnType<typeof diagnoseEmptyPreview>;
  nothingMatches: boolean;
}) {
  const diagnosisCopy: Record<NonNullable<ReturnType<typeof diagnoseEmptyPreview>>, string> = {
    source_error: "检索源响应异常，这次「0 命中」不代表没有资源；稍后重试或让站长检查检索源。",
    unreleased: "该作品尚未上线数字版，公开源通常还没有可转存的高清资源。",
    no_candidates: "本次检索没有拿到任何候选，可以精简搜索词后重试。",
    priority_unmatched: "所有候选都没命中优先级组，被整体过滤了；可以清空优先级组再试。",
    wrong_title: "搜到的大多是别的作品，不是这部——换个更完整的片名、加年份或改用原名重搜。",
    rule_excludes_all: "这条规则排除了全部候选——检查一下是不是写得太严。",
  };
  return (
    <div className="sub-policy-preview">
      <p className="sub-policy-headline">{previewHeadlineCopy(preview)}</p>
      {diagnosis !== null ? <p className="sub-policy-warn">{diagnosisCopy[diagnosis]}</p> : null}
      {!nothingMatches && diagnosis === "rule_excludes_all" ? null : null}
      {preview.matched.length > 0 ? (
        <>
          <p className="sub-policy-sublist-label">命中 {preview.matched.length} 个</p>
          <ul className="sub-policy-matched">
            {preview.matched.map((name) => <li key={name}>{name}</li>)}
          </ul>
        </>
      ) : null}
      {preview.excluded.length > 0 ? (
        <>
          <p className="sub-policy-sublist-label">排除 {preview.excluded.length} 个</p>
          <ul className="sub-policy-excluded">
            {preview.excluded.map((entry) => (
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

export { mapSavedPolicy };
