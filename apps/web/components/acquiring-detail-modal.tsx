"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { X, Loader2, AlertTriangle, Clock3 } from "lucide-react";
import type { InProgressTitle } from "../lib/title-hub";

export interface AcquiringDetailModalProps {
  title: InProgressTitle;
  storageId?: string | undefined;
  onClose: () => void;
  onCancelled?: () => void;
}

interface LiveStatus {
  runId: string;
  runStatus: "queued" | "running";
  queuePosition: number | null;
  phase: string;
  percent: number;
  activity: string;
  steps: Array<{ time: string; tool: string; headline: string }>;
  auditEvents: Array<{ type: string; message: string }>;
}

function mediaTypeLabel(type: "movie" | "tv" | "anime"): string {
  if (type === "movie") return "电影";
  if (type === "tv") return "剧集";
  return "动漫";
}

function AcquiringTitleSummary({ title }: { title: InProgressTitle }) {
  return (
    <div className="acquiring-title-summary">
      {title.posterPath ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`https://image.tmdb.org/t/p/w185${title.posterPath}`}
          alt=""
          className="acquiring-modal-poster"
        />
      ) : (
        <span className="acquiring-modal-poster-fallback">{title.title.slice(0, 4)}</span>
      )}
      <div className="acquiring-title-meta">
        <h3>{title.title}</h3>
        <div className="acquiring-meta-chips">
          <span>{title.year}</span>
          <span>·</span>
          <span>{mediaTypeLabel(title.type)}</span>
          {typeof title.seasonNumber === "number" && title.seasonNumber > 0 ? (
            <>
              <span>·</span>
              <span>第 {title.seasonNumber} 季</span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AcquiringProgressSection({
  status,
  percent,
  activity,
  queuePosition,
}: {
  status: "queued" | "running";
  percent: number;
  activity: string;
  queuePosition: number | null;
}) {
  const isQueued = status === "queued";
  const badgeLabel = isQueued
    ? queuePosition
      ? `排队中 (#${queuePosition})`
      : "排队中"
    : "正在获取";

  return (
    <div className="acquiring-progress-box">
      <div className="acquiring-progress-head">
        <span className={`hub-badge ${isQueued ? "tone-amber" : "tone-indigo"}`}>
          {isQueued ? <Clock3 size={12} aria-hidden /> : <Loader2 size={12} className="spin" aria-hidden />}
          {badgeLabel}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-muted)" }}>{percent}%</span>
      </div>
      <div className="acquiring-progress-track">
        <div className="acquiring-progress-fill" style={{ width: `${Math.max(5, Math.min(100, percent))}%` }} />
      </div>
      <p className="acquiring-activity-desc">{activity}</p>
    </div>
  );
}

function AcquiringTimelineSection({
  steps,
  auditEvents,
}: {
  steps: Array<{ time: string; tool: string; headline: string }>;
  auditEvents: Array<{ type: string; message: string }>;
}) {
  const hasSteps = steps.length > 0;
  const hasAudit = auditEvents.length > 0;
  if (!hasSteps && !hasAudit) return null;

  return (
    <div className="acquiring-timeline">
      <span className="acquiring-timeline-title">执行记录</span>
      <ul className="acquiring-steps-list">
        {hasSteps
          ? steps.map((s, idx) => (
              <li key={idx} className={`acquiring-step-item ${idx === steps.length - 1 ? "is-latest" : ""}`}>
                <span className="acquiring-step-dot" />
                <span>{s.headline}</span>
              </li>
            ))
          : auditEvents.map((a, idx) => (
              <li key={idx} className={`acquiring-step-item ${idx === auditEvents.length - 1 ? "is-latest" : ""}`}>
                <span className="acquiring-step-dot" />
                <span>{a.message}</span>
              </li>
            ))}
      </ul>
    </div>
  );
}

function useAcquiringLiveStatus(
  title: InProgressTitle,
  storageId: string | undefined,
  onCancelled: (() => void) | undefined,
) {
  const [live, setLive] = useState<LiveStatus | null>(null);
  const router = useRouter();

  const fetchStatus = useCallback(async () => {
    try {
      const q = new URLSearchParams();
      q.set("tmdbId", String(title.tmdbId));
      if (storageId) q.set("w", storageId);
      if (title.runId) q.set("runId", title.runId);

      const res = await fetch(`/api/activity/status?${q.toString()}`);
      if (!res.ok) return;
      const data = (await res.json()) as { active?: boolean } & Partial<LiveStatus>;
      if (data.active === false) {
        onCancelled?.();
        router.refresh();
        return;
      }
      if (data.runId) {
        setLive({
          runId: data.runId,
          runStatus: data.runStatus ?? "running",
          queuePosition: data.queuePosition ?? null,
          phase: data.phase ?? "transfer",
          percent: data.percent ?? 45,
          activity: data.activity ?? "正在获取...",
          steps: data.steps ?? [],
          auditEvents: data.auditEvents ?? [],
        });
      }
    } catch {
      // 忽略轮询网络失败
    }
  }, [title.tmdbId, title.runId, storageId, onCancelled, router]);

  useEffect(() => {
    void fetchStatus();
    const interval = setInterval(() => {
      void fetchStatus();
    }, 2500);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  return live;
}

function resolveDisplayMetrics(live: LiveStatus | null, title: InProgressTitle) {
  const currentStatus: "queued" | "running" = live?.runStatus ?? title.status ?? "running";
  const defaultPercent = currentStatus === "queued" ? 5 : 45;
  const currentPercent = live?.percent ?? title.progress?.percent ?? defaultPercent;
  const currentActivity = live?.activity ?? title.activityText ?? "正在获取资源并转存中...";
  const currentQueuePosition = live?.queuePosition ?? title.queuePosition ?? null;
  return { currentStatus, currentPercent, currentActivity, currentQueuePosition };
}

interface ModalFooterProps {
  confirmingCancel: boolean;
  cancelling: boolean;
  onStartConfirm: () => void;
  onDismissConfirm: () => void;
  onConfirmCancel: () => void;
  onClose: () => void;
}

function AcquiringModalFooter({
  confirmingCancel,
  cancelling,
  onStartConfirm,
  onDismissConfirm,
  onConfirmCancel,
  onClose,
}: ModalFooterProps) {
  if (confirmingCancel) {
    return (
      <div className="acquiring-confirm-cancel">
        <span className="acquiring-confirm-text">确定取消此获取任务？</span>
        <div className="acquiring-confirm-buttons">
          <button
            type="button"
            className="secondary-button"
            onClick={onDismissConfirm}
            disabled={cancelling}
            style={{ fontSize: 12, padding: "4px 10px" }}
          >
            暂不取消
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={onConfirmCancel}
            disabled={cancelling}
            style={{ background: "#dc2626", borderColor: "#dc2626", fontSize: 12, padding: "4px 10px" }}
          >
            {cancelling ? "正在取消..." : "确认取消"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className="secondary-button"
        onClick={onStartConfirm}
        style={{ color: "#f87171", borderColor: "rgba(248, 113, 113, 0.2)", fontSize: 12, padding: "4px 10px" }}
      >
        取消获取
      </button>
      <button
        type="button"
        className="secondary-button"
        onClick={onClose}
        style={{ fontSize: 12, padding: "4px 12px" }}
      >
        关闭
      </button>
    </>
  );
}

export function AcquiringDetailModal({
  title,
  storageId,
  onClose,
  onCancelled,
}: AcquiringDetailModalProps) {
  const live = useAcquiringLiveStatus(title, storageId, onCancelled);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleCancel = async () => {
    const runIdToCancel = live?.runId ?? title.runId;
    if (!runIdToCancel) {
      setErrorMsg("未获取到任务标识，请刷新后再试。");
      return;
    }
    setCancelling(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/activity/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: runIdToCancel, allowRunning: true }),
      });
      const data = (await res.json()) as { status?: string; error?: string };
      if (data.status === "cancelled") {
        router.refresh();
        onCancelled?.();
        onClose();
      } else {
        setErrorMsg(data.error ?? "未能取消任务，请稍后再试。");
        setCancelling(false);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "网络异常，取消请求失败。");
      setCancelling(false);
    }
  };

  const { currentStatus, currentPercent, currentActivity, currentQueuePosition } = resolveDisplayMetrics(live, title);

  return (
    <div className="acquiring-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="acquiring-modal" onClick={(e) => e.stopPropagation()}>
        <div className="acquiring-modal-header">
          <h2>
            <Loader2 size={16} className="spin" aria-hidden />
            任务进度详情
          </h2>
          <button type="button" className="acquiring-modal-close" onClick={onClose} aria-label="关闭">
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className="acquiring-modal-body">
          <AcquiringTitleSummary title={title} />
          <AcquiringProgressSection
            status={currentStatus}
            percent={currentPercent}
            activity={currentActivity}
            queuePosition={currentQueuePosition}
          />
          <AcquiringTimelineSection
            steps={live?.steps ?? []}
            auditEvents={live?.auditEvents ?? []}
          />
          {errorMsg ? (
            <p style={{ color: "#f87171", fontSize: 13, margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
              <AlertTriangle size={14} aria-hidden />
              {errorMsg}
            </p>
          ) : null}
        </div>

        <div className="acquiring-modal-footer">
          <AcquiringModalFooter
            confirmingCancel={confirmingCancel}
            cancelling={cancelling}
            onStartConfirm={() => setConfirmingCancel(true)}
            onDismissConfirm={() => setConfirmingCancel(false)}
            onConfirmCancel={() => void handleCancel()}
            onClose={onClose}
          />
        </div>
      </div>
    </div>
  );
}
