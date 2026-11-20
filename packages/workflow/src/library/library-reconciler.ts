import type { LibraryPathBinding } from "@media-track/contracts";
import type {
  SqliteMediaLibraryRepository,
  ReconcileBindingEpisodesResult,
} from "../persistence/sqlite/sqlite-media-library.js";

export interface StorageInventoryItem {
  fileId: string;
  fileName: string;
  relativePath: string;
  sizeBytes: number;
  pickCode?: string | null;
}

export interface StorageInventoryAdapter {
  readonly provider: string;
  probeFileExists(storageId: string, fileId: string): Promise<boolean>;
}

export interface ReconcileContext {
  binding: LibraryPathBinding;
  discoveredFiles: StorageInventoryItem[];
  repo: SqliteMediaLibraryRepository;
  forceAllowEmptyCleanup?: boolean;
}

export interface LibraryReconciliationStrategy {
  readonly name: string;
  reconcile(context: ReconcileContext): Promise<ReconcileBindingEpisodesResult>;
}

export class SafeSoftDeleteStrategy implements LibraryReconciliationStrategy {
  readonly name = "soft_delete";

  async reconcile(context: ReconcileContext): Promise<ReconcileBindingEpisodesResult> {
    const discoveredFileIds = context.discoveredFiles.map((f) => f.fileId);
    return context.repo.reconcileBindingEpisodes({
      bindingId: context.binding.id,
      libraryId: context.binding.libraryId,
      discoveredFileIds,
      strategy: "soft_delete",
      forceAllowEmptyCleanup: context.forceAllowEmptyCleanup,
    });
  }
}

export class StrictMirrorPurgeStrategy implements LibraryReconciliationStrategy {
  readonly name = "strict_purge";

  async reconcile(context: ReconcileContext): Promise<ReconcileBindingEpisodesResult> {
    const discoveredFileIds = context.discoveredFiles.map((f) => f.fileId);
    return context.repo.reconcileBindingEpisodes({
      bindingId: context.binding.id,
      libraryId: context.binding.libraryId,
      discoveredFileIds,
      strategy: "strict_purge",
      forceAllowEmptyCleanup: context.forceAllowEmptyCleanup,
    });
  }
}

export function evaluatePruneSafety(params: {
  dbTotalCount: number;
  discoveredCount: number;
  orphanCount: number;
  maxDeleteRate?: number;
  forceAllowEmptyCleanup?: boolean;
}): { safe: boolean; reason?: string } {
  const {
    dbTotalCount,
    discoveredCount,
    orphanCount,
    maxDeleteRate = 0.3,
    forceAllowEmptyCleanup = false,
  } = params;

  if (discoveredCount === 0 && dbTotalCount > 0 && !forceAllowEmptyCleanup) {
    return {
      safe: false,
      reason: "EMPTY_DISCOVERY_BLOCKED: 远端遍历结果为 0，触发空盘防清空熔断保护",
    };
  }

  if (dbTotalCount >= 10 && !forceAllowEmptyCleanup) {
    const deleteRate = orphanCount / dbTotalCount;
    if (deleteRate > maxDeleteRate) {
      return {
        safe: false,
        reason: `HIGH_PRUNE_RATE_BLOCKED: 待清理比例 ${(deleteRate * 100).toFixed(1)}% 超过安全阈值 ${(maxDeleteRate * 100).toFixed(1)}% (${orphanCount}/${dbTotalCount})`,
      };
    }
  }

  return { safe: true };
}
