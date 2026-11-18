"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConnectedStorageView } from "../../../../lib/workflow-runtime";
import type { ResourceCandidateView } from "@media-track/workflow";
import { RemoteFolderPickerModal } from "./remote-folder-picker-modal";
import {
  DEFAULT_FILTER_CRITERIA,
  extractFacets,
  filterCandidates,
  paginateCandidates,
  sortCandidates,
  type ResourceFilterCriteria,
} from "../../../acquisition/contracts/resource-filter-model";
import type { SearchBackendView } from "../../../storage-drives/application/owner-ingest-service";
import {
  BackendPicker,
  CandidateList,
  SearchRow,
  StatusBanner,
  SubmitRow,
  SubmissionsPanel,
  TargetRow,
  mapRunStatusToPhase,
  type InspectionState,
  type InspectionStatus,
  type SubmissionState,
} from "./owner-ingest-console-parts";

/**
 * 站长「关键字投放」控制台（有状态部分）。
 *
 * 设计要点（对应 docs 方案 §5）：
 *  - **服务端判定**：候选的可提交性由服务端能力决定；这里只渲染 verdict，不再
 *    本地过滤「哪些行能提交」（那是上一轮 storage-offline 弹窗的缺陷）。
 *  - **可视化目录**：复用 `RemoteFolderPickerModal`（盘上树形下钻）。
 *  - **落盘才算入库**：提交后逐条轮询 `/api/owner/ingest/status`，状态来自
 *    `workflow_runs`（DB 唯一事实源），不是本地计时器。
 *  - **结果筛选是纯展示**：类型/分辨率/体积/关键词过滤与分页只作用于已取回的
 *    候选（`ResourceFilterBar` 同一套契约），不改服务端判定、不重发检索。
 *  - **分享存活校验**：勾选后点「校验链接」，服务端按目标盘的账号去列分享
 *    根目录；`unknown` 就是未校验，绝不冒充「有效」。
 *  - 纯展示的子组件在 `owner-ingest-console-parts.tsx`（单文件行数门禁）。
 */

interface BackendsResponse {
  backendsByStorage?: Record<string, SearchBackendView[]>;
}

export function OwnerIngestConsole({ storages }: { storages: ConnectedStorageView[] }) {
  const [storageId, setStorageId] = useState<string>("");
  const [keyword, setKeyword] = useState<string>("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchRunId, setSearchRunId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ResourceCandidateView[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [criteria, setCriteria] = useState<ResourceFilterCriteria>(DEFAULT_FILTER_CRITERIA);
  // 分页只作用于「已取回的候选」：改变筛选 / 翻页都不会重发检索。
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [backends, setBackends] = useState<SearchBackendView[]>([]);
  const [selectedBackends, setSelectedBackends] = useState<Set<string>>(new Set());
  const [inspections, setInspections] = useState<Record<string, InspectionState>>({});

  const [targetDir, setTargetDir] = useState<string>("");
  const [targetPath, setTargetPath] = useState<string>("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<SubmissionState[]>([]);

  const activeStorage = useMemo(
    () => storages.find((entry) => entry.id === storageId),
    [storages, storageId],
  );

  useEffect(() => {
    if (storageId === "" && storages.length > 0) {
      setStorageId(storages[0]!.id);
    }
  }, [storages, storageId]);

  // 可用后端按盘取（GET 端点返回 backendsByStorage）。换盘 = 换后端列表。
  useEffect(() => {
    if (storageId === "") {
      setBackends([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/owner/ingest/search");
        if (!res.ok) return;
        const data = (await res.json().catch(() => ({}))) as BackendsResponse;
        if (cancelled) return;
        setBackends(data.backendsByStorage?.[storageId] ?? []);
      } catch {
        // 后端列表拿不到不影响检索：不传 backends = 用全部已配置后端。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storageId]);

  const facets = useMemo(() => extractFacets(candidates), [candidates]);
  // 两个数字分开算：`filtered` 只含当前页，`filteredTotal` 才是筛选后的总数。
  const filteredTotalItems = useMemo(
    () => sortCandidates(filterCandidates(candidates, criteria), criteria.sortBy).length,
    [candidates, criteria],
  );
  const filtered = useMemo(() => {
    const matches = filterCandidates(candidates, criteria);
    return paginateCandidates(sortCandidates(matches, criteria.sortBy), page, pageSize);
  }, [candidates, criteria, page, pageSize]);

  const toggleBackend = useCallback(
    (backend: string) => {
      setSelectedBackends((prev) => {
        const next = new Set(prev);
        if (next.has(backend)) next.delete(backend);
        else next.add(backend);
        // 全部取消/全选都等于「全用」：空集合就是「不限制」，不制造无法检索的死状态。
        if (next.size === backends.length) next.clear();
        return next;
      });
    },
    [backends.length],
  );

  const inspectSelected = useCallback(async () => {
    if (searchRunId === null || selectedIds.size === 0 || storageId === "") return;
    const ids = [...selectedIds];
    setInspections((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = { status: "probing", loading: true };
      return next;
    });
    try {
      const res = await fetch("/api/owner/ingest/inspect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ storageId, searchRunId, candidateIds: ids }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        inspections?: Array<{ candidateId: string; status: InspectionStatus; message?: string; fileCount?: number }>;
      };
      if (!res.ok) {
        // 整体失败也不谎报「有效」：一律落成 unknown（未校验）。
        setInspections((prev) => {
          const next = { ...prev };
          for (const id of ids) next[id] = { status: "unknown", loading: false, message: data.error ?? "校验失败" };
          return next;
        });
        return;
      }
      setInspections((prev) => {
        const next = { ...prev };
        for (const item of data.inspections ?? []) {
          next[item.candidateId] = {
            status: item.status,
            loading: false,
            ...(item.message === undefined ? {} : { message: item.message }),
            ...(item.fileCount === undefined ? {} : { fileCount: item.fileCount }),
          };
        }
        return next;
      });
    } catch (error) {
      setInspections((prev) => {
        const next = { ...prev };
        for (const id of ids) {
          next[id] = { status: "unknown", loading: false, message: error instanceof Error ? error.message : "校验请求异常" };
        }
        return next;
      });
    }
  }, [searchRunId, selectedIds, storageId]);

  const handleSearch = useCallback(async () => {
    if (searching) return;
    if (keyword.trim().length === 0) {
      setSearchError("请输入检索关键词");
      return;
    }
    if (storageId === "") {
      setSearchError("请先选择目标网盘");
      return;
    }
    setSearching(true);
    setSearchError(null);
    setSelectedIds(new Set());
    setSubmissions([]);
    setInspections({});
    setPage(1);
    try {
      const res = await fetch("/api/owner/ingest/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          keyword: keyword.trim(),
          storageId,
          backends: selectedBackends.size === 0 ? undefined : [...selectedBackends],
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        retryAfterMs?: number;
        searchRunId?: string;
        candidates?: ResourceCandidateView[];
      };
      if (!res.ok || data.searchRunId === undefined) {
        // 429 带 retryAfterMs：只说「稍后再试」会让站长反复点击、每点一次都撞同一把锁。
        const waitSeconds =
          res.status === 429 && typeof data.retryAfterMs === "number"
            ? Math.max(1, Math.ceil(data.retryAfterMs / 1000))
            : null;
        setSearchError(
          waitSeconds === null
            ? (data.error ?? "检索失败")
            : `${data.error ?? "检索过于频繁"}（还需等待 ${waitSeconds} 秒）`,
        );
        setCandidates([]);
        setSearchRunId(null);
        return;
      }
      setSearchRunId(data.searchRunId);
      setCandidates(data.candidates ?? []);
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : "检索请求异常");
    } finally {
      setSearching(false);
    }
  }, [keyword, searching, selectedBackends, storageId]);

  const toggleCandidate = useCallback((candidateId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(candidateId)) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    if (searchRunId === null) {
      setSubmitError("请先检索出候选资源");
      return;
    }
    if (targetDir === "") {
      setSubmitError("请选择入库目录");
      return;
    }
    if (selectedIds.size === 0) {
      setSubmitError("请至少勾选一个候选");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/owner/ingest/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          storageId,
          searchRunId,
          directoryId: targetDir,
          displayPath: targetPath,
          candidateIds: [...selectedIds],
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        submissions?: Array<{ candidateId: string; status: string; workflowRunId?: string; message?: string; reason?: string }>;
      };
      if (!res.ok) {
        setSubmitError(data.error ?? "提交失败");
        return;
      }
      const titleById = new Map(candidates.map((entry) => [entry.candidateId, entry.title]));
      setSubmissions(
        (data.submissions ?? []).map((entry) => ({
          candidateId: entry.candidateId,
          candidateTitle: titleById.get(entry.candidateId) ?? entry.candidateId,
          ...(entry.workflowRunId === undefined ? {} : { workflowRunId: entry.workflowRunId }),
          phase:
            entry.status === "queued" ? "queued" : entry.status === "already_running" ? "already_running" : "rejected",
          message: entry.message ?? entry.reason,
        })),
      );
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "提交请求异常");
    } finally {
      setSubmitting(false);
    }
  }, [candidates, searchRunId, selectedIds, storageId, submitting, targetDir, targetPath]);

  // 逐条轮询状态：数据来自 DB（workflow_runs），终态后停止。
  useEffect(() => {
    const pending = submissions.filter(
      (entry) => entry.workflowRunId !== undefined && (entry.phase === "queued" || entry.phase === "running"),
    );
    if (pending.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const ids = pending.map((entry) => entry.workflowRunId!).join(",");
          const res = await fetch(`/api/owner/ingest/status?workflowRunIds=${encodeURIComponent(ids)}`);
          if (!res.ok) return;
          const data = (await res.json().catch(() => ({}))) as {
            submissions?: Array<{
              workflowRunId: string;
              status: string;
              landedFileCount?: number | null;
              error?: string | null;
            }>;
          };
          if (cancelled) return;
          setSubmissions((prev) =>
            prev.map((entry) => {
              const hit = data.submissions?.find((item) => item.workflowRunId === entry.workflowRunId);
              if (!hit) return entry;
              return {
                ...entry,
                phase: mapRunStatusToPhase(hit.status),
                landedFileCount: hit.landedFileCount ?? entry.landedFileCount,
                message: hit.error ?? entry.message,
              };
            }),
          );
        } catch {
          // 网络抖动下一轮再试；终态由 DB 决定，不依赖这次成功。
        }
      })();
    }, 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [submissions]);

  if (storages.length === 0) {
    return (
      <section className="panel">
        <div className="panel-header">
          <span className="panel-title">关键字投放</span>
        </div>
        <p className="panel-note">还没有已连接的网盘。请先在「网盘管理」中连接至少一块盘。</p>
      </section>
    );
  }

  return (
    <section className="panel" style={{ display: "grid", gap: "1rem" }}>
      <div className="panel-header" style={{ justifyContent: "space-between" }}>
        <div>
          <span className="panel-title">关键字投放（站长）</span>
          <p className="panel-note">
            只按关键字检索，不走影视搜索；勾选结果、选好盘上目录后排队转存。落盘确认后才计入入库。
          </p>
        </div>
      </div>

      <SearchRow
        storages={storages}
        storageId={storageId}
        onStorageChange={(id) => {
          setStorageId(id);
          setTargetDir("");
          setTargetPath("");
        }}
        keyword={keyword}
        onKeywordChange={setKeyword}
        searching={searching}
        onSearch={() => void handleSearch()}
      />

      <BackendPicker views={backends} selected={selectedBackends} onToggle={toggleBackend} />

      {searchError !== null && <StatusBanner text={searchError} />}

      {candidates.length > 0 && (
        <CandidateList
          candidates={candidates}
          filteredItems={filtered.items}
          filteredTotal={filteredTotalItems}
          selectedIds={selectedIds}
          onToggle={toggleCandidate}
          criteria={criteria}
          onCriteriaChange={(updater) => {
            setCriteria(updater);
            setPage(1);
          }}
          facets={facets}
          inspections={inspections}
          onInspect={() => void inspectSelected()}
          pagination={filtered}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
          onResetCriteria={() => {
            setCriteria(DEFAULT_FILTER_CRITERIA);
            setPage(1);
          }}
        />
      )}

      {candidates.length === 0 && searchRunId !== null && !searching && (
        <p className="panel-note">这次检索没有返回可用候选。换个关键字或换一块盘再试。</p>
      )}

      <TargetRow targetPath={targetPath} onOpenPicker={() => setPickerOpen(true)} />

      {submitError !== null && <StatusBanner text={submitError} />}

      <SubmitRow
        submitting={submitting}
        selectedCount={selectedIds.size}
        canSubmit={targetDir !== ""}
        onSubmit={() => void handleSubmit()}
      />

      {submissions.length > 0 && <SubmissionsPanel submissions={submissions} />}

      {pickerOpen && (
        <RemoteFolderPickerModal
          storageId={storageId}
          initialFolderId={targetDir || "0"}
          title={`选择入库目录（${activeStorage?.label ?? activeStorage?.provider ?? ""}）`}
          onSelect={(folderId, fullPath) => {
            setTargetDir(folderId);
            setTargetPath(fullPath);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </section>
  );
}
