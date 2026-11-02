"use client";

import { useCallback, useState } from "react";
import type { ResourceInspectionResult } from "@media-track/workflow";
import type {
  CandidateInspectionState,
  ResourceLinkResponse,
} from "../contracts/acquisition-types";
import type { CandidateLinkState } from "../components/resource-candidate-row";

interface UseCandidateActionsParams {
  tmdbId: number;
  snapshotId: string | null;
  streaming: boolean;
}

export function useCandidateActions({
  tmdbId,
  snapshotId,
  streaming,
}: UseCandidateActionsParams) {
  const [linkStates, setLinkStates] = useState<Record<string, CandidateLinkState>>({});
  const [inspectionStates, setInspectionStates] = useState<
    Record<string, CandidateInspectionState>
  >({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const resetActions = useCallback(() => {
    setLinkStates({});
    setInspectionStates({});
    setCopiedId(null);
  }, []);

  const handleToggleLink = useCallback(
    async (candidateId: string) => {
      const existing = linkStates[candidateId];
      if (existing?.open) {
        setLinkStates((prev) => ({
          ...prev,
          [candidateId]: { ...existing, open: false },
        }));
        return;
      }
      if (existing?.data) {
        setLinkStates((prev) => ({
          ...prev,
          [candidateId]: { ...existing, open: true },
        }));
        return;
      }

      if (streaming || snapshotId === null) {
        const error = streaming
          ? "请等待搜索完成生成快照后再查看链接"
          : "缓存结果无链接快照，请重新查询";
        setLinkStates((prev) => ({
          ...prev,
          [candidateId]: { open: true, loading: false, error },
        }));
        return;
      }

      setLinkStates((prev) => ({
        ...prev,
        [candidateId]: { open: true, loading: true },
      }));

      try {
        const response = await fetch("/api/titles/resources/link", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tmdbId,
            snapshotId,
            candidateId,
          }),
        });
        const body = (await response.json().catch(() => ({}))) as Partial<ResourceLinkResponse> & {
          error?: string;
        };

        if (!response.ok) {
          setLinkStates((prev) => ({
            ...prev,
            [candidateId]: {
              open: true,
              loading: false,
              error: body.error ?? `获取失败 (${response.status})`,
            },
          }));
          return;
        }

        setLinkStates((prev) => ({
          ...prev,
          [candidateId]: {
            open: true,
            loading: false,
            data: body as CandidateLinkState["data"],
          },
        }));
      } catch (err) {
        setLinkStates((prev) => ({
          ...prev,
          [candidateId]: {
            open: true,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          },
        }));
      }
    },
    [linkStates, snapshotId, streaming, tmdbId],
  );

  const handleInspectCandidate = useCallback(
    async (candidateId: string) => {
      const existing = inspectionStates[candidateId];
      if (existing?.loading || (existing && existing.status !== "idle" && existing.status !== "rate_limited")) {
        return;
      }

      if (streaming || snapshotId === null) {
        setInspectionStates((prev) => ({
          ...prev,
          [candidateId]: {
            status: "unknown",
            loading: false,
            message: streaming ? "请等待搜索完成后探活" : "请重新检索后再探测",
          },
        }));
        return;
      }

      setInspectionStates((prev) => ({
        ...prev,
        [candidateId]: {
          status: "probing",
          loading: true,
        },
      }));

      try {
        const res = await fetch("/api/titles/resources/inspect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tmdbId,
            snapshotId,
            candidateId,
          }),
        });

        const data = (await res.json().catch(() => ({}))) as ResourceInspectionResult & {
          error?: string;
        };

        if (!res.ok) {
          setInspectionStates((prev) => ({
            ...prev,
            [candidateId]: {
              status: "unknown",
              loading: false,
              message: data.error ?? `嗅探失败 (${res.status})`,
            },
          }));
          return;
        }

        setInspectionStates((prev) => ({
          ...prev,
          [candidateId]: {
            status: data.status,
            loading: false,
            message: data.message,
            totalSizeBytes: data.totalSizeBytes,
            fileCount: data.fileCount,
            files: data.files,
          },
        }));
      } catch (err) {
        setInspectionStates((prev) => ({
          ...prev,
          [candidateId]: {
            status: "unknown",
            loading: false,
            message: err instanceof Error ? err.message : String(err),
          },
        }));
      }
    },
    [inspectionStates, snapshotId, streaming, tmdbId],
  );

  const handleCopyLink = useCallback(async (candidateId: string, text: string) => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      setCopiedId(candidateId);
      setTimeout(() => {
        setCopiedId((curr) => (curr === candidateId ? null : curr));
      }, 2000);
    } catch {
      // ignore
    }
  }, []);

  return {
    linkStates,
    inspectionStates,
    copiedId,
    handleToggleLink,
    handleInspectCandidate,
    handleCopyLink,
    resetActions,
  };
}
