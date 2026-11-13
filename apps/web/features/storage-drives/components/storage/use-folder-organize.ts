"use client";

import { useCallback, useState } from "react";

/**
 * 网盘目录「整理与多版本归档」编排。
 *
 * 背景：整理接口要求该片处于「追踪态」（由工作流运行记录反推），而盘里已有的内容
 * 从未跑过任务，于是必然返回 409 `NOT_TRACKED`。修复策略是**引导式两步**：
 *   1. 收到 NOT_TRACKED → 展示确认条（说明不会触发下载）；
 *   2. 确认后调用既有 `/api/storage/files/adopt` 把该目录纳入媒体库；
 *   3. 重试整理。
 *
 * 为什么放在前端编排而不是服务端自动 adopt：
 * - adopt 会新增标题/季/集记录（可见副作用），需要用户显式同意；
 * - `/api/storage/files/adopt` 已实现 TMDB 识别、目录嗅探与快照写入，
 *   在服务端重复一遍会带来 200+ 行重复逻辑与分叉风险。
 *
 * 为什么把目录名/面包屑都交给本 Hook 解析：视图组件有复杂度预算（15），
 * 内联 `??` / `?.` 与分支会直接顶穿门禁。
 */

export interface OrganizeContext {
  storageId: string;
  directoryId: string;
  directoryName: string;
  tmdbId: number;
  seasonNumber?: number | undefined;
  parentFolderName?: string | undefined;
}

export interface OrganizeBreadcrumb {
  id: string;
  name: string;
}

export interface UseFolderOrganizeOptions {
  /** 当前选中的网盘；为空表示还没选盘。 */
  storageId: string | undefined;
  /** 当前目录（整理目标）。 */
  directoryId: string;
  /** 当前目录名；staging 目录整理后需要回到上一级。 */
  directoryName: string | undefined;
  /** 面包屑（用于 adopt 的身份校验与 staging 回退）。 */
  breadcrumbs: readonly OrganizeBreadcrumb[];
  /** 目录名里解析出的 TMDB id；解析不到时为 null。 */
  tmdbId: number | null;
  onNavigateFolder: (id: string, name: string) => void;
  onReload: () => Promise<void> | void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}

interface OrganizeResponse {
  ok: boolean;
  status: number;
  body: { copy?: string; error?: string; code?: string; unrecognizedCount?: number };
}

interface UnrecognizedFixResponse {
  scanned?: number;
  fixed?: number;
  results?: Array<{ from?: string; to?: string; reason?: string }>;
}

/**
 * 由当前目录信息构造整理上下文（纯函数，便于单测）。
 * 季号只在「Season NN / 第 N 季」这类目录里可推断；其它情况留空。
 */
export function buildOrganizeContext(input: {
  storageId: string;
  directoryId: string;
  directoryName: string;
  tmdbId: number;
  parentFolderName?: string | undefined;
}): OrganizeContext {
  const match = /^(?:Season\s*(\d+)|第\s*(\d+)\s*季)$/i.exec(input.directoryName.trim());
  const seasonNumber = match ? Number(match[1] ?? match[2]) : undefined;
  return {
    storageId: input.storageId,
    directoryId: input.directoryId,
    directoryName: input.directoryName,
    tmdbId: input.tmdbId,
    ...(seasonNumber !== undefined && Number.isFinite(seasonNumber) ? { seasonNumber } : {}),
    ...(input.parentFolderName ? { parentFolderName: input.parentFolderName } : {}),
  };
}

/** staging-* 目录整理后会被清理，需要回到上一级影视主目录。 */
export function findStagingParentCrumb(
  directoryName: string | undefined,
  breadcrumbs: readonly OrganizeBreadcrumb[],
): OrganizeBreadcrumb | null {
  if (!directoryName?.toLowerCase().startsWith("staging-")) return null;
  if (breadcrumbs.length < 2) return null;
  return breadcrumbs[breadcrumbs.length - 2] ?? null;
}

async function postOrganize(context: OrganizeContext): Promise<OrganizeResponse> {
  const response = await fetch("/api/titles/organize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tmdbId: context.tmdbId,
      directoryId: context.directoryId,
      storageId: context.storageId,
      ...(context.seasonNumber !== undefined ? { seasonNumber: context.seasonNumber } : {}),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as OrganizeResponse["body"];
  return { ok: response.ok, status: response.status, body };
}

async function postAdopt(context: OrganizeContext): Promise<void> {
  const response = await fetch("/api/storage/files/adopt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storageId: context.storageId,
      folderId: context.directoryId,
      folderName: context.directoryName,
      tmdbId: context.tmdbId,
      ...(context.seasonNumber !== undefined ? { seasonNumber: context.seasonNumber } : {}),
      ...(context.parentFolderName ? { parentFolderName: context.parentFolderName } : {}),
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "纳入媒体库失败");
  }
}

/**
 * 一键补全缺扩展名的文件。
 *
 * 只把「盘 + 目录」交给服务端，由服务端自己重新扫描候选、读文件头判定容器，
 * 客户端不参与"猜扩展名"——避免把 mkv 改成 mp4 这类不可逆错误。
 */
async function postFixUnrecognized(input: { storageId: string; directoryId: string }): Promise<UnrecognizedFixResponse> {
  const response = await fetch("/api/titles/organize/unrecognized", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storageId: input.storageId, directoryId: input.directoryId }),
  });
  const body = (await response.json().catch(() => ({}))) as UnrecognizedFixResponse & { error?: string };
  if (!response.ok) throw new Error(body.error || "补全扩展名失败");
  return body;
}

/** 汇总补后缀结果文案：修好几个、跳过几个、为什么跳过。 */
export function describeFixResult(result: UnrecognizedFixResponse): string {
  const fixed = result.fixed ?? 0;
  const results = result.results ?? [];
  const skipped = results.filter((item) => item.to === undefined);
  const head = fixed > 0 ? `已为 ${fixed} 个文件补全扩展名` : "没有文件被改名";
  if (skipped.length === 0) return head;
  const reasons = Array.from(new Set(skipped.map((item) => item.reason ?? "未识别")));
  return `${head}，${skipped.length} 个跳过（${reasons.join("；")}）`;
}

export function useFolderOrganize(options: UseFolderOrganizeOptions) {
  const [busy, setBusy] = useState(false);
  const [pendingAdopt, setPendingAdopt] = useState<OrganizeContext | null>(null);
  const [pendingUnrecognized, setPendingUnrecognized] = useState<
    { count: number; storageId: string; directoryId: string } | null
  >(null);
  const { onSuccess, onError, onReload, onNavigateFolder, breadcrumbs, directoryName } = options;

  /** 整理成功后：若有缺扩展名文件，挂出提示条（数量由服务端扫描得出）。 */
  const handleOrganizeSuccess = useCallback(
    (result: OrganizeResponse, context: OrganizeContext) => {
      onSuccess(result.body.copy || "整理完成");
      const count = result.body.unrecognizedCount ?? 0;
      setPendingUnrecognized(
        count > 0 ? { count, storageId: context.storageId, directoryId: context.directoryId } : null,
      );
    },
    [onSuccess],
  );

  const afterSuccess = useCallback(async () => {
    const stagingParent = findStagingParentCrumb(directoryName, breadcrumbs);
    if (stagingParent) {
      onNavigateFolder(stagingParent.id, stagingParent.name);
      return;
    }
    await onReload();
  }, [breadcrumbs, directoryName, onNavigateFolder, onReload]);

  const runOrganize = useCallback(
    async (context: OrganizeContext) => {
      setBusy(true);
      try {
        const result = await postOrganize(context);
        if (result.status === 409 && result.body.code === "NOT_TRACKED") {
          setPendingAdopt(context);
          return;
        }
        if (!result.ok) throw new Error(result.body.error || "整理失败");
        handleOrganizeSuccess(result, context);
        await afterSuccess();
      } catch (error) {
        onError(error instanceof Error ? error.message : "整理出错");
      } finally {
        setBusy(false);
      }
    },
    [afterSuccess, handleOrganizeSuccess, onError],
  );

  const organizeCurrentFolder = useCallback(() => {
    const { storageId, tmdbId, directoryId } = options;
    if (!storageId || !tmdbId) return;
    void runOrganize(
      buildOrganizeContext({
        storageId,
        directoryId,
        directoryName: directoryName ?? "",
        tmdbId,
        parentFolderName: breadcrumbs[breadcrumbs.length - 2]?.name,
      }),
    );
  }, [breadcrumbs, directoryName, options, runOrganize]);

  const confirmAdopt = useCallback(async () => {
    const context = pendingAdopt;
    if (!context) return;
    setBusy(true);
    try {
      await postAdopt(context);
      setPendingAdopt(null);
      const result = await postOrganize(context);
      if (!result.ok) throw new Error(result.body.error || "纳入后整理仍失败");
      handleOrganizeSuccess(result, context);
      await afterSuccess();
    } catch (error) {
      onError(error instanceof Error ? error.message : "纳入并整理出错");
    } finally {
      setBusy(false);
    }
  }, [afterSuccess, handleOrganizeSuccess, onError, pendingAdopt]);

  const cancelAdopt = useCallback(() => setPendingAdopt(null), []);

  const fixUnrecognized = useCallback(async () => {
    const pending = pendingUnrecognized;
    if (!pending) return;
    setBusy(true);
    try {
      const result = await postFixUnrecognized({
        storageId: pending.storageId,
        directoryId: pending.directoryId,
      });
      setPendingUnrecognized(null);
      onSuccess(describeFixResult(result));
      await onReload();
    } catch (error) {
      onError(error instanceof Error ? error.message : "补全扩展名出错");
    } finally {
      setBusy(false);
    }
  }, [onError, onReload, onSuccess, pendingUnrecognized]);

  const dismissUnrecognized = useCallback(() => setPendingUnrecognized(null), []);

  return {
    busy,
    pendingAdopt,
    pendingUnrecognized,
    organizeCurrentFolder,
    confirmAdopt,
    cancelAdopt,
    fixUnrecognized,
    dismissUnrecognized,
  };
}
