import {
  WORKSPACE_COOKIE_NAME,
  resolveWorkspaceWithChain,
  isRegisteredStorageProvider,
  type WorkflowScope,
} from "@media-track/workflow";
import { getWorkflowRepository } from "../../composition/runtime-container";
import { getCurrentAccountId } from "../../platform/next-context/request-account";

/**
 * 读取当前请求携带的偏好工作区 Cookie (mediary_active_workspace)
 */
export async function getActiveWorkspaceCookie(): Promise<string | undefined> {
  try {
    const { cookies } = await import("next/headers");
    const cookieStore = await cookies();
    return cookieStore.get(WORKSPACE_COOKIE_NAME)?.value;
  } catch {
    return undefined;
  }
}

export type ResolvedWorkspaceScope = WorkflowScope & {
  basePath: string;
  activeStorageId: string | undefined;
};

/**
 * 依据路径参数与持久化偏好链解析当前请求的工作区范围 (WorkflowScope)
 */
export async function getActiveWorkspaceScope(storageId?: string): Promise<ResolvedWorkspaceScope> {
  const accountId = await getCurrentAccountId();
  const storages = (await getWorkflowRepository().listConnectedStorages(accountId)).filter((s) =>
    isRegisteredStorageProvider(s.provider),
  );
  const preferredStorageId = storageId === undefined ? await getActiveWorkspaceCookie() : undefined;
  const resolved = resolveWorkspaceWithChain({ accountId, storages, pathStorageId: storageId, preferredStorageId });
  return {
    accountId,
    connectedStorageId: resolved.storageId || null,
    basePath: resolved.basePath,
    activeStorageId: resolved.isPrimary ? undefined : resolved.storageId,
  };
}

/**
 * 依据 Query 参数与持久化偏好链解析全局工作区
 */
export async function resolveGlobalWorkspace(w: string | undefined) {
  const accountId = await getCurrentAccountId();
  const storages = (await getWorkflowRepository().listConnectedStorages(accountId)).filter((s) =>
    isRegisteredStorageProvider(s.provider),
  );
  const preferredStorageId = w === undefined ? await getActiveWorkspaceCookie() : undefined;
  const resolved = resolveWorkspaceWithChain({ accountId, storages, queryStorageId: w, preferredStorageId });
  return {
    accountId,
    connectedStorageId: resolved.storageId || null,
    basePath: resolved.basePath,
    activeStorageId: resolved.isPrimary ? undefined : resolved.storageId,
  };
}

/**
 * 根路由访问时检测是否需要 307 重定向到用户偏好的非主盘工作区
 */
export async function resolvePreferredWorkspaceRedirect(
  accountId: string,
  storageId: string | undefined,
  searchParams?: Record<string, string | string[] | undefined>,
): Promise<string | null> {
  if (storageId !== undefined) return null;
  const preferredId = await getActiveWorkspaceCookie();
  if (!preferredId) return null;
  const storages = (await getWorkflowRepository().listConnectedStorages(accountId)).filter((s) =>
    isRegisteredStorageProvider(s.provider),
  );
  if (storages.length < 2) return null;
  const primary = [...storages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!primary || preferredId === primary.id || !storages.some((s) => s.id === preferredId)) return null;

  const queryStr = searchParams
    ? new URLSearchParams(
        Object.entries(searchParams).flatMap(([k, v]) =>
          Array.isArray(v) ? v.map((item) => [k, item]) : typeof v === "string" ? [[k, v]] : [],
        ),
      ).toString()
    : "";
  return `/w/${preferredId}${queryStr ? `?${queryStr}` : ""}`;
}
