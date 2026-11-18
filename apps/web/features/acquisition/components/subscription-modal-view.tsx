"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AppConfirmDialog } from "../../../components/ui/app-confirm-dialog";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Loader2, Sparkles, X } from "lucide-react";
import type { PolicyDraft, PresetKind } from "../core/policy-draft";
import { previewHeadlineCopy, previewReasonCopy, type PreviewExcludeReason, type PreviewOutcome, type PreviewProgress } from "../core/policy-preview";
import {
  PolicyFilterSection,
  SeasonSelectorSection,
  StorageSelectorSection,
  type ConnectedDriveSummary,
  type SubscriptionSeasonItem,
} from "./subscription-modal-fields";

export interface SubscriptionModalViewProps {
  isOpen: boolean;
  mounted: boolean;
  onClose: () => void;
  title: string;
  year: number;
  posterPath?: string | null | undefined;
  initialTracked: boolean;
  step: 0 | 1 | 2;
  setStep: (step: 0 | 1 | 2) => void;
  isTv: boolean;
  shouldQueueAcquisition: boolean;
  normalizedSeasons: SubscriptionSeasonItem[];
  allSeasonNums: number[];
  selectedSeasons: Set<number>;
  excludeSpecial: boolean;
  onToggleSeason: (seasonNumber: number) => void;
  onSelectAll: () => void;
  onSelectLatest: () => void;
  onToggleExcludeSpecial: (exclude: boolean) => void;
  drives: ConnectedDriveSummary[];
  selectedStorageId: string;
  onSelectStorageId: (id: string) => void;
  activePreset: PresetKind;
  draft: PolicyDraft;
  preview: PreviewOutcome | null;
  previewProgress: PreviewProgress | null;
  previewError: string | null;
  /** >0 = 预览被限流，剩余秒数；此时「预览效果」按钮禁用并显示倒计时。 */
  previewThrottleSeconds: number;
  validationIssues: { field: string; message: string }[];
  /** 用户点过「继续」后才显示校验错误（不在打字途中报红）。 */
  validationRequested: boolean;
  /** 表单是否已被用户修改过（取消关闭时的守卫）。 */
  isDirty: boolean;
  onApplyPreset: (preset: PresetKind) => void;
  onToggleChip: (field: "mustContain" | "mustNotContain", chip: string) => void;
  onDraftChange: (patch: Partial<PolicyDraft>) => void;
  onMustContainChange: (value: string) => void;
  onMustNotContainChange: (value: string) => void;
  onSaveAsTemplate: (draft: PolicyDraft) => unknown;
  runPreview: () => Promise<boolean>;
  errorMsg: string | null;
  isSubmitting: boolean;
  onBack: () => void;
  onContinue: () => void;
}

export function SubscriptionModalView(props: SubscriptionModalViewProps) {
  const [confirmClose, setConfirmClose] = useState(false);

  /** 脏表单守卫：Esc / 点背景 / ✕ 都不直接丢弃 3 步填写的内容。 */
  const requestClose = () => {
    if (props.isSubmitting) return;
    if (props.isDirty) setConfirmClose(true);
    else props.onClose();
  };

  useEffect(() => {
    if (!props.isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !confirmClose && !props.isSubmitting) requestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!props.isOpen || !props.mounted) return null;

  return createPortal(
    <>
      <div
        className="acquiring-modal-backdrop"
        onClick={requestClose}
        role="dialog"
        aria-modal="true"
        aria-labelledby="subscription-config-title"
        style={{ zIndex: 9999 }}
      >
        <div className="acquiring-modal subscription-config-modal" onClick={(event) => event.stopPropagation()}>
          <ModalHeader initialTracked={props.initialTracked} onClose={requestClose} isSubmitting={props.isSubmitting} />
          <SubscriptionStepper step={props.step} setStep={props.setStep} isSubmitting={props.isSubmitting} onBack={props.onBack} />
          <ModalBody {...props} />
          <ModalFooter {...props} />
        </div>
      </div>
      <AppConfirmDialog
        spec={confirmClose ? {
          title: "放弃未保存的订阅设置？",
          description: "当前填写的筛选规则与选择的范围还没有保存，关闭后将丢失。",
          confirmLabel: "放弃并关闭",
          cancelLabel: "继续编辑",
          isDanger: true,
        } : null}
        onConfirm={() => { setConfirmClose(false); props.onClose(); }}
        onCancel={() => setConfirmClose(false)}
      />
    </>,
    document.body,
  );
}

function ModalHeader({ initialTracked, onClose, isSubmitting }: Pick<SubscriptionModalViewProps, "initialTracked" | "onClose" | "isSubmitting">) {
  return (
    <div className="acquiring-modal-header">
      <h2 id="subscription-config-title">
        <Sparkles size={16} aria-hidden style={{ color: "#6366f1" }} />
        {initialTracked ? "调整订阅策略" : "创建订阅"}
      </h2>
      <button type="button" className="acquiring-modal-close" onClick={onClose} aria-label="关闭" disabled={isSubmitting}>
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}

function SubscriptionStepper({ step, setStep, isSubmitting, onBack }: Pick<SubscriptionModalViewProps, "step" | "setStep" | "isSubmitting" | "onBack">) {
  return (
    <nav className="subscription-config-steps" aria-label="订阅设置步骤">
      {["范围", "策略", "预览与确认"].map((label, index) => (
        <button
          key={label}
          type="button"
          className={step === index ? "is-current" : step > index ? "is-complete" : ""}
          aria-current={step === index ? "step" : undefined}
          disabled={index > step || isSubmitting}
          onClick={() => { if (index < step) onBackToStep(index, onBack, setStep); }}
        >
          <span>{step > index ? "✓" : index + 1}</span>
          {label}
        </button>
      ))}
    </nav>
  );
}

function onBackToStep(index: number, onBack: () => void, setStep: (step: 0 | 1 | 2) => void) {
  if (index >= 0 && index <= 2) {
    onBack();
    setStep(index as 0 | 1 | 2);
  }
}

function ModalBody(props: SubscriptionModalViewProps) {
  return (
    <div className="acquiring-modal-body subscription-config-body">
      <TitleSummary
        title={props.title}
        year={props.year}
        posterPath={props.posterPath}
        isTv={props.isTv}
        seasonCount={props.normalizedSeasons.length}
      />
      <SubscriptionStepContent {...props} />
      {props.errorMsg ? (
        <p className="subscription-config-error" role="alert">
          <AlertTriangle size={14} aria-hidden />
          {props.errorMsg}
        </p>
      ) : null}
    </div>
  );
}

function TitleSummary({ title, year, posterPath, isTv, seasonCount }: {
  title: string;
  year: number;
  posterPath?: string | null | undefined;
  isTv: boolean;
  seasonCount: number;
}) {
  return (
    <div className="acquiring-title-summary">
      {posterPath ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={posterPath.startsWith("http") ? posterPath : `https://image.tmdb.org/t/p/w185${posterPath}`}
          alt=""
          className="acquiring-modal-poster"
        />
      ) : <span className="acquiring-modal-poster-fallback">{title.slice(0, 4)}</span>}
      <div className="acquiring-title-meta">
        <h3 style={{ fontSize: 15, margin: "0 0 4px" }}>{title}</h3>
        <div className="acquiring-meta-chips" style={{ fontSize: 12 }}>
          <span>{year}</span><span>·</span><span>{isTv ? "剧集" : "电影"}</span>
          {isTv && seasonCount > 0 ? <><span>·</span><span>共 {seasonCount} 季</span></> : null}
        </div>
      </div>
    </div>
  );
}

function SubscriptionStepContent(props: SubscriptionModalViewProps) {
  if (props.step === 0) return <ScopeStep {...props} />;
  if (props.step === 1) return <PolicyStep {...props} />;
  return <ReviewStep {...props} />;
}

function ScopeStep(props: SubscriptionModalViewProps) {
  return (
    <section className="subscription-config-section" aria-label="选择追踪范围">
      <h3>选择保存位置与追踪范围</h3>
      <StorageSelectorSection
        drives={props.drives}
        selectedStorageId={props.selectedStorageId}
        onSelectStorageId={props.onSelectStorageId}
      />
      <SeasonSelectorSection
        isTv={props.isTv}
        normalizedSeasons={props.normalizedSeasons}
        selectedSeasons={props.selectedSeasons}
        allSeasonNums={props.allSeasonNums}
        excludeSpecial={props.excludeSpecial}
        onToggleSeason={props.onToggleSeason}
        onSelectAll={props.onSelectAll}
        onSelectLatest={props.onSelectLatest}
        onToggleExcludeSpecial={props.onToggleExcludeSpecial}
      />
      {props.isTv && props.selectedSeasons.size === 0 ? <p className="subscription-config-error">至少选择一季才能继续。</p> : null}
    </section>
  );
}

function PolicyStep(props: SubscriptionModalViewProps) {
  return (
    <section className="subscription-config-section" aria-label="配置订阅策略">
      <h3>设置资源筛选规则</h3>
      <PolicyFilterSection
        activePreset={props.activePreset}
        draft={props.draft}
        preview={props.preview}
        previewProgress={props.previewProgress}
        previewError={props.previewError}
        onApplyPreset={props.onApplyPreset}
        onToggleChip={props.onToggleChip}
        onDraftChange={props.onDraftChange}
        onMustContainChange={props.onMustContainChange}
        onMustNotContainChange={props.onMustNotContainChange}
        onSaveAsTemplate={props.onSaveAsTemplate}
        seasonNumbers={[...props.selectedSeasons]}
      />
      {props.validationRequested && props.validationIssues.length > 0 ? (
        <p className="subscription-config-error" role="alert">
          <AlertTriangle size={14} aria-hidden /> {props.validationIssues[0]!.message}
        </p>
      ) : null}
      <p className="subscription-config-hint">每个已选季度可单独设置起始集与结束集；资源筛选规则仍由各季共用，追踪后也可在作品详情中分别修改。</p>
    </section>
  );
}

function ReviewStep(props: SubscriptionModalViewProps) {
  return (
    <section className="subscription-config-section" aria-label="预览并确认订阅">
      <h3>确认订阅设置</h3>
      <ReviewSummary {...props} />
      <ReviewResources {...props} />
      <p className="subscription-config-hint">首次检索会在策略保存成功后加入后台队列；失败时可修正规则后重试。</p>
    </section>
  );
}

function ReviewSummary(props: SubscriptionModalViewProps) {
  const seasonScope = [...props.selectedSeasons].sort((a, b) => a - b).map((season) => `第 ${season} 季`).join("、");
  const seasonRanges = summarizeSeasonEpisodeRanges(props.selectedSeasons, props.draft.seasonEpisodeRanges ?? []);
  return (
    <dl className="subscription-config-summary">
      <div><dt>追踪范围</dt><dd>{props.isTv ? seasonScope : "电影"}</dd></div>
      <div><dt>保存位置</dt><dd>{props.drives.find((drive) => drive.id === props.selectedStorageId)?.label ?? "默认网盘"}</dd></div>
      <div><dt>包含条件</dt><dd>{props.draft.mustContain || "不限制"}</dd></div>
      <div><dt>排除条件</dt><dd>{props.draft.mustNotContain || "不限制"}</dd></div>
      <div><dt>字幕</dt><dd>{props.draft.subtitleRequire ? "必须有中文字幕" : "中字优先（不强制）"}</dd></div>
      {props.isTv ? <div><dt>逐季起止集</dt><dd>{seasonRanges || "未选择季度"}</dd></div> : null}
      <div><dt>额外集数筛选</dt><dd>{props.draft.episodeFilter || "不限制"}</dd></div>
    </dl>
  );
}

function ReviewResources(props: SubscriptionModalViewProps) {
  return (
    <div className="subscription-config-preview" aria-live="polite">
      <div className="subscription-config-preview-head">
        <h4>当前资源预览</h4>
        <button type="button" onClick={() => void props.runPreview()} disabled={props.previewProgress !== null}>
          {props.previewProgress !== null ? "搜索中…" : "重新预览"}
        </button>
      </div>
      {props.previewProgress !== null ? (
        <p>
          正在检索 {props.previewProgress.done} / {props.previewProgress.total || "?"} 个关键词
          {props.previewProgress.currentKeyword ? `（当前：${props.previewProgress.currentKeyword}）` : ""}
        </p>
      ) : null}
      {props.previewError ? <p className="subscription-config-error">{props.previewError}</p> : null}
      {props.previewThrottleSeconds > 0 ? (
        <p className="subscription-config-hint" role="status" aria-live="polite">
          预览与手动检索共用 60 秒限速，{props.previewThrottleSeconds} 秒后可再试。
        </p>
      ) : null}
      {props.preview ? <PreviewResult preview={props.preview} /> : null}
      {!props.preview && props.previewProgress === null && !props.previewError ? <p>尚未生成预览。</p> : null}
    </div>
  );
}

function summarizeSeasonEpisodeRanges(seasons: Set<number>, ranges: NonNullable<PolicyDraft["seasonEpisodeRanges"]>): string {
  return [...seasons].sort((a, b) => a - b).map((season) => {
    const range = ranges.find((item) => item.seasonNumber === season);
    const label = season === 0 ? "特别篇" : `第 ${season} 季`;
    const start = String(range?.startEpisode ?? 1).padStart(2, "0");
    const end = range?.endEpisode === null || range?.endEpisode === undefined
      ? "起"
      : `–E${String(range.endEpisode).padStart(2, "0")}`;
    return `${label} E${start}${end}`;
  }).join("；");
}

function PreviewResult({ preview }: { preview: PreviewOutcome }) {
  return (
    <>
      <p>{previewHeadlineCopy(preview)}</p>
      {preview.matched.length > 0 ? <ul>{preview.matched.slice(0, 5).map((name) => <li key={name}>{name}</li>)}</ul> : null}
      {preview.excluded.slice(0, 5).map((item) => (
        <p className="subscription-config-excluded" key={item.name}>
          {item.name}<span>{reasonLabel(item.reason)}</span>
        </p>
      ))}
      {preview.matchedCount === 0 && preview.excludedByReason.wrong_title
        ? <p className="subscription-config-hint">搜到的大多是别的作品，不是这部——换个更完整的片名、加年份或改用原名重搜。</p>
        : null}
      {preview.total > 5 ? <small>列表仅显示前 5 项。</small> : null}
    </>
  );
}

/**
 * 排除原因文案统一走 core/policy-preview 的 previewReasonCopy —— 向导与详情页
 * 之前各写一份 switch，`wrong_title` 上线时只有一边被更新。
 */
function reasonLabel(reason: string): string {
  return previewReasonCopy(reason as PreviewExcludeReason);
}

function ModalFooter(props: SubscriptionModalViewProps) {
  const busy = props.isSubmitting || props.previewProgress !== null;
  const previewBlocked = props.step === 1 && props.previewThrottleSeconds > 0;
  return (
    <div className="acquiring-modal-footer">
      <button
        type="button"
        className="secondary-button"
        onClick={props.onBack}
        disabled={busy}
        style={{ padding: "6px 14px", fontSize: 13 }}
      >
        {props.step === 0 ? "取消" : <><ChevronLeft size={14} aria-hidden /> 上一步</>}
      </button>
      <button
        type="button"
        className="primary-button"
        onClick={props.onContinue}
        disabled={busy || previewBlocked || (props.step === 0 && props.isTv && props.selectedSeasons.size === 0)}
        style={{ padding: "6px 18px", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}
      >
        {busy ? (
          <Loader2 size={14} className="spin" aria-hidden />
        ) : props.step === 2 ? (
          <CheckCircle2 size={14} aria-hidden />
        ) : <ChevronRight size={14} aria-hidden />}
        {footerLabel(props)}
      </button>
    </div>
  );
}

function footerLabel(props: SubscriptionModalViewProps): string {
  if (props.isSubmitting) return "正在保存…";
  if (props.previewProgress !== null) return "正在预览…";
  if (props.step === 0) return "继续配置策略";
  if (props.step === 1) {
    return props.previewThrottleSeconds > 0 ? `请稍候 ${props.previewThrottleSeconds}s` : "预览效果";
  }
  if (props.shouldQueueAcquisition && props.isTv) return "保存策略并获取所选季";
  if (props.shouldQueueAcquisition) return "保存并启动首次检索";
  return "保存策略";
}
