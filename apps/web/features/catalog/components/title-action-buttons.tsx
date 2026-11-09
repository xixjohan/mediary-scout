"use client";

import { Check, DownloadCloud, Layers, LoaderCircle, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "../../../lib/use-router";
import {
  requestRemainingAction,
  requestSeasonAction,
  manualSubscriptionSearchAction,
  type ManualSubscriptionSearchActionResult,
  type RequestTrackingActionResult,
} from "../../../app/actions/acquisition-actions";
import { runAction } from "../../../lib/run-action";
import { useAcquisitionLock } from "../../acquisition/components/acquisition-lock";
import { AcquireResultNotice, isLockedResult } from "../../acquisition/components/request-state";
import { isDemoModeClient } from "../../../lib/demo-mode";
import { DemoAcquirePlayback } from "../../acquisition/components/demo-acquire-playback";
import type { DemoAcquisitionEntry } from "../../../lib/demo-session";
import { useDemoAcquiredTmdbIds } from "../../../lib/use-demo-session";
import { SubscriptionModal } from "../../acquisition/components/subscription-modal";
import type { SubscriptionSeasonItem } from "../../acquisition/components/subscription-modal-fields";

export function RequestSeasonButton({
  tmdbId,
  seasonNumber,
  storageId,
  titleAcquiring = false,
  demoEntry,
}: {
  tmdbId: number;
  seasonNumber: number;
  /** Tree model: the active workspace drive — acquisition lands HERE. REQUIRED
   *  (value may be undefined = primary) so the workspace is always threaded. */
  storageId: string | undefined;
  /** Server truth: this title already has an acquisition run in flight. */
  titleAcquiring?: boolean;
  /** Demo only: recorded to the session library when the scripted playback ends. */
  demoEntry?: DemoAcquisitionEntry | undefined;
}) {
  const router = useRouter();
  const lock = useAcquisitionLock();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<RequestTrackingActionResult | null>(null);
  const scope = `season-${seasonNumber}`;
  const isLocked = isLockedResult(result);
  const mine = lock?.acquiring === scope;
  const othersAcquiring = (lock != null && lock.acquiring != null && !mine) || titleAcquiring;
  const inFlight = isPending || mine;
  const demo = isDemoModeClient();
  const [demoPlaying, setDemoPlaying] = useState(false);
  const acquiredIds = useDemoAcquiredTmdbIds();

  if (demo && demoPlaying) {
    return <DemoAcquirePlayback entry={demoEntry} />;
  }

  if (demo && acquiredIds.has(tmdbId)) {
    return (
      <span className="hub-badge tone-green">
        <Check size={13} aria-hidden />
        已获取
      </span>
    );
  }

  return (
    <>
      <button
        className="season-request-button"
        type="button"
        title={
          othersAcquiring && !inFlight ? "该剧正在获取中，请稍候" : result?.message ?? `获取第 ${seasonNumber} 季`
        }
        disabled={isPending || isLocked || othersAcquiring}
        onClick={() => {
          if (demo) {
            setDemoPlaying(true);
            return;
          }
          lock?.lock(scope);
          startTransition(async () => {
            const r = await runAction(
              () => requestSeasonAction({ tmdbId, seasonNumber, storageId }),
              (msg) => {
                setResult({ status: "unsupported", message: msg });
                // 必须 refresh:lock.acquiring 是前端 state,靠重挂载重置。
                // 失败不刷新,锁永远卡住,兄弟按钮全禁用(Copilot round 1)。
                router.refresh();
              },
            );
            if (!r.ok) return;
            setResult(r.value);
            router.refresh();
          });
        }}
      >
        {inFlight ? (
          <LoaderCircle size={13} className="spin" aria-hidden />
        ) : isLocked ? (
          <Check size={13} aria-hidden />
        ) : (
          <DownloadCloud size={13} aria-hidden />
        )}
        {inFlight ? "获取中" : isLocked ? "已请求" : "获取本季"}
      </button>
      <AcquireResultNotice result={result} />
    </>
  );
}

export function ManualSubscriptionSearchButton({
  tmdbId,
  mediaType,
  seasonNumber,
  storageId,
  activityHref,
  isAcquiring = false,
  disabledReason,
}: {
  tmdbId: number;
  mediaType: "movie" | "tv" | "anime";
  seasonNumber?: number;
  storageId: string | undefined;
  activityHref: string;
  isAcquiring?: boolean;
  disabledReason?: string | undefined;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<ManualSubscriptionSearchActionResult | null>(null);

  return (
    <div className="manual-subscription-search-action">
      <button
        className="secondary-button"
        type="button"
        disabled={isPending || isAcquiring || Boolean(disabledReason)}
        title={disabledReason}
        onClick={() => {
          startTransition(async () => {
            const response = await runAction(
              () => manualSubscriptionSearchAction({
                tmdbId,
                mediaType,
                ...(seasonNumber === undefined ? {} : { seasonNumber }),
                  ...(storageId === undefined ? {} : { storageId }),
              }),
              (message) => setResult({ status: "invalid_target", message }),
            );
            if (!response.ok) return;
            setResult(response.value);
            router.refresh();
          });
        }}
      >
        {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
        {isPending ? "正在提交" : isAcquiring ? "搜索中" : "立即搜索缺失资源"}
      </button>
      {isAcquiring || result?.workflowRunId ? (
        <Link href={activityHref} className="manual-subscription-search-activity-link">
          查看活动
        </Link>
      ) : null}
      {result ? <span role="status">{result.message}</span> : null}
      {disabledReason ? <span>{disabledReason}</span> : null}
    </div>
  );
}

export function RequestRemainingButton({
  tmdbId,
  label,
  storageId,
  titleAcquiring = false,
  demoEntry,
}: {
  tmdbId: number;
  label: string;
  /** Tree model: the active workspace drive — acquisition lands HERE. REQUIRED
   *  (value may be undefined = primary) so the workspace is always threaded. */
  storageId: string | undefined;
  /** Server truth: this title already has an acquisition run in flight. */
  titleAcquiring?: boolean;
  /** Demo only: recorded to the session library when the scripted playback ends. */
  demoEntry?: DemoAcquisitionEntry | undefined;
}) {
  const router = useRouter();
  const lock = useAcquisitionLock();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<RequestTrackingActionResult | null>(null);
  const scope = "remaining";
  const isLocked = isLockedResult(result);
  const mine = lock?.acquiring === scope;
  const othersAcquiring = (lock != null && lock.acquiring != null && !mine) || titleAcquiring;
  const inFlight = isPending || mine;
  const demo = isDemoModeClient();
  const [demoPlaying, setDemoPlaying] = useState(false);
  const acquiredIds = useDemoAcquiredTmdbIds();

  if (demo && demoPlaying) {
    return <DemoAcquirePlayback entry={demoEntry} />;
  }

  if (demo && acquiredIds.has(tmdbId)) {
    return (
      <span className="hub-badge tone-green">
        <Check size={13} aria-hidden />
        已获取
      </span>
    );
  }

  return (
    <>
      <button
        className="primary-button"
        type="button"
        title={othersAcquiring && !inFlight ? "该剧正在获取中，请稍候" : result?.message ?? label}
        disabled={isPending || isLocked || othersAcquiring}
        onClick={() => {
          if (demo) {
            setDemoPlaying(true);
            return;
          }
          lock?.lock(scope);
          startTransition(async () => {
            const r = await runAction(
              () => requestRemainingAction({ tmdbId, storageId }),
              (msg) => {
                setResult({ status: "unsupported", message: msg });
                // 同上一处:失败必须 refresh 清锁,否则 sibling 全禁用。
                router.refresh();
              },
            );
            if (!r.ok) return;
            setResult(r.value);
            router.refresh();
          });
        }}
      >
        {inFlight ? (
          <LoaderCircle size={14} className="spin" aria-hidden />
        ) : isLocked ? (
          <Check size={14} aria-hidden />
        ) : (
          <Layers size={14} aria-hidden />
        )}
        {inFlight ? "获取中" : isLocked ? "已请求" : label}
      </button>
      <AcquireResultNotice result={result} />
    </>
  );
}

export function SubscriptionConfigButton({
  tmdbId,
  title,
  year,
  posterPath,
  seasons,
  storageId,
  initialTracked = false,
  titleAcquiring = false,
}: {
  tmdbId: number;
  title: string;
  year: number;
  posterPath: string | null;
  seasons: SubscriptionSeasonItem[];
  storageId: string | undefined;
  initialTracked?: boolean;
  titleAcquiring?: boolean;
}) {
  const router = useRouter();
  const demo = isDemoModeClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [demoPlaying, setDemoPlaying] = useState(false);
  const [result, setResult] = useState<RequestTrackingActionResult | null>(null);
  const demoEntry: DemoAcquisitionEntry = { tmdbId, title, year, type: "tv", posterPath };

  if (demo && demoPlaying) return <DemoAcquirePlayback entry={demoEntry} />;

  return (
    <>
      <button
        className="secondary-button"
        type="button"
        disabled={titleAcquiring}
        title={titleAcquiring ? "该剧正在获取中，请稍候" : "选择季范围并配置自动筛选策略"}
        onClick={() => {
          if (demo) setDemoPlaying(true);
          else setModalOpen(true);
        }}
      >
        <SlidersHorizontal size={14} aria-hidden />
        按策略获取
      </button>
      <AcquireResultNotice result={result} />
      {modalOpen ? (
        <SubscriptionModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          tmdbId={tmdbId}
          title={title}
          year={year}
          mediaType="tv"
          posterPath={posterPath}
          initialStorageId={storageId}
          initialTracked={initialTracked}
          seasons={seasons}
          onSuccess={(response) => {
            setResult({ status: response.status as RequestTrackingActionResult["status"], message: response.message });
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
