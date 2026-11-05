/**
 * 工作区决议与持久化偏好引擎 (Workspace Resolution & Preference Engine)
 *
 * 采用三大经典设计模式：
 * 1. 策略模式 (Strategy Pattern) + 责任链模式 (Chain of Responsibility)：
 *    按 Path -> Query -> Preference -> PrimaryFallback 优先级链式决议活跃网盘
 * 2. 适配器模式 (Adapter Pattern)：
 *    抽象 IWorkspacePreferenceAdapter 隔离 Cookie 与内存单测
 * 3. 状态机模式 (Finite State Machine, FSM)：
 *    规范化切换器的生命周期状态 (idle -> validating -> switching -> degraded_fallback)
 */

import { WorkspaceNotFoundError } from "./workflow-scope.js";

export const WORKSPACE_COOKIE_NAME = "mediary_active_workspace";

export interface WorkspaceStorageSummary {
  id: string;
  createdAt: string;
  label?: string | null | undefined;
  provider?: string | undefined;
  status?: string | undefined;
}

export interface WorkspaceResolutionContext {
  accountId: string;
  storages: ReadonlyArray<WorkspaceStorageSummary>;
  pathStorageId?: string | undefined;
  queryStorageId?: string | undefined;
  preferredStorageId?: string | undefined;
}

export type WorkspaceResolutionSource = "path" | "query" | "preference" | "primary";

export interface ResolvedWorkspace {
  storageId: string;
  source: WorkspaceResolutionSource;
  isPrimary: boolean;
  basePath: string;
  shouldSyncPreference: boolean;
}

/** 策略接口 */
export interface IWorkspaceResolutionStrategy {
  readonly name: string;
  readonly priority: number;
  resolve(ctx: WorkspaceResolutionContext): ResolvedWorkspace | null;
}

/** 辅助获取最早创建的主盘 ID */
function getPrimaryStorageId(storages: ReadonlyArray<WorkspaceStorageSummary>): string | null {
  if (storages.length === 0) return null;
  return [...storages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!.id;
}

/** 1. 显式路径策略 (最高优先级: 100) */
export class PathWorkspaceStrategy implements IWorkspaceResolutionStrategy {
  readonly name = "PathWorkspaceStrategy";
  readonly priority = 100;

  resolve(ctx: WorkspaceResolutionContext): ResolvedWorkspace | null {
    if (!ctx.pathStorageId) {
      return null;
    }
    const primaryId = getPrimaryStorageId(ctx.storages);
    const owned = ctx.storages.some((s) => s.id === ctx.pathStorageId);
    if (!owned) {
      throw new WorkspaceNotFoundError(ctx.pathStorageId);
    }
    const isPrimary = ctx.pathStorageId === primaryId;
    return {
      storageId: ctx.pathStorageId,
      source: "path",
      isPrimary,
      basePath: isPrimary ? "/" : `/w/${ctx.pathStorageId}`,
      shouldSyncPreference: true,
    };
  }
}

/** 2. 显式查询参数策略 (次高优先级: 80) */
export class QueryWorkspaceStrategy implements IWorkspaceResolutionStrategy {
  readonly name = "QueryWorkspaceStrategy";
  readonly priority = 80;

  resolve(ctx: WorkspaceResolutionContext): ResolvedWorkspace | null {
    if (!ctx.queryStorageId) {
      return null;
    }
    const primaryId = getPrimaryStorageId(ctx.storages);
    const owned = ctx.storages.some((s) => s.id === ctx.queryStorageId);
    if (!owned) {
      // 查询参数属于弱引用，不报错，回退给后续策略
      return null;
    }
    const isPrimary = ctx.queryStorageId === primaryId;
    return {
      storageId: ctx.queryStorageId,
      source: "query",
      isPrimary,
      basePath: isPrimary ? "/" : `/w/${ctx.queryStorageId}`,
      shouldSyncPreference: true,
    };
  }
}

/** 3. 持久化偏好策略 (中优先级: 60) */
export class PreferenceWorkspaceStrategy implements IWorkspaceResolutionStrategy {
  readonly name = "PreferenceWorkspaceStrategy";
  readonly priority = 60;

  resolve(ctx: WorkspaceResolutionContext): ResolvedWorkspace | null {
    if (!ctx.preferredStorageId || ctx.storages.length < 2) {
      return null;
    }
    const primaryId = getPrimaryStorageId(ctx.storages);
    const owned = ctx.storages.some((s) => s.id === ctx.preferredStorageId);
    if (!owned) {
      // 幽灵网盘自愈防御：若已解绑则忽略，回退给后续策略
      return null;
    }
    const isPrimary = ctx.preferredStorageId === primaryId;
    return {
      storageId: ctx.preferredStorageId,
      source: "preference",
      isPrimary,
      basePath: isPrimary ? "/" : `/w/${ctx.preferredStorageId}`,
      shouldSyncPreference: false,
    };
  }
}

/** 4. 主盘兜底策略 (兜底优先级: 10) */
export class PrimaryFallbackStrategy implements IWorkspaceResolutionStrategy {
  readonly name = "PrimaryFallbackStrategy";
  readonly priority = 10;

  resolve(ctx: WorkspaceResolutionContext): ResolvedWorkspace {
    const primaryId = getPrimaryStorageId(ctx.storages);
    if (!primaryId) {
      return {
        storageId: "",
        source: "primary",
        isPrimary: true,
        basePath: "/",
        shouldSyncPreference: false,
      };
    }
    return {
      storageId: primaryId,
      source: "primary",
      isPrimary: true,
      basePath: "/",
      shouldSyncPreference: false,
    };
  }
}

/** 责任链调度器 */
export class WorkspaceResolutionChain {
  private readonly strategies: IWorkspaceResolutionStrategy[];

  constructor(customStrategies?: IWorkspaceResolutionStrategy[]) {
    this.strategies = customStrategies ?? [
      new PathWorkspaceStrategy(),
      new QueryWorkspaceStrategy(),
      new PreferenceWorkspaceStrategy(),
      new PrimaryFallbackStrategy(),
    ];
    this.strategies.sort((a, b) => b.priority - a.priority);
  }

  resolve(ctx: WorkspaceResolutionContext): ResolvedWorkspace {
    for (const strategy of this.strategies) {
      const result = strategy.resolve(ctx);
      if (result) {
        return result;
      }
    }
    const fallback = new PrimaryFallbackStrategy();
    return fallback.resolve(ctx);
  }
}

/** 便捷纯函数解析入口 */
export function resolveWorkspaceWithChain(
  ctx: WorkspaceResolutionContext,
  chain?: WorkspaceResolutionChain,
): ResolvedWorkspace {
  const runner = chain ?? new WorkspaceResolutionChain();
  return runner.resolve(ctx);
}

/** 适配器接口与测试实现 */
export interface IWorkspacePreferenceAdapter {
  getPreference(): Promise<string | null>;
  setPreference(storageId: string): Promise<void>;
  clearPreference(): Promise<void>;
}

export class MemoryWorkspacePreferenceAdapter implements IWorkspacePreferenceAdapter {
  private preference: string | null = null;

  async getPreference(): Promise<string | null> {
    return this.preference;
  }

  async setPreference(storageId: string): Promise<void> {
    this.preference = storageId;
  }

  async clearPreference(): Promise<void> {
    this.preference = null;
  }
}

/** 状态机状态与流转 */
export type WorkspaceSwitcherStatus =
  | "idle"
  | "validating"
  | "switching"
  | "degraded_fallback";

export interface WorkspaceSwitcherMachineState {
  currentStorageId: string;
  status: WorkspaceSwitcherStatus;
  targetStorageId?: string | undefined;
}

export function transitionWorkspaceState(
  current: WorkspaceSwitcherMachineState,
  action:
    | { type: "START_SWITCH"; targetStorageId: string }
    | { type: "VALIDATION_SUCCESS" }
    | { type: "VALIDATION_FAILED" }
    | { type: "COMPLETED" },
): WorkspaceSwitcherMachineState {
  switch (action.type) {
    case "START_SWITCH":
      return {
        currentStorageId: current.currentStorageId,
        targetStorageId: action.targetStorageId,
        status: "validating",
      };
    case "VALIDATION_SUCCESS":
      return {
        currentStorageId: current.targetStorageId ?? current.currentStorageId,
        status: "switching",
      };
    case "VALIDATION_FAILED":
      return {
        currentStorageId: current.currentStorageId,
        status: "degraded_fallback",
      };
    case "COMPLETED":
      return {
        currentStorageId: current.currentStorageId,
        status: "idle",
      };
    default:
      return current;
  }
}
