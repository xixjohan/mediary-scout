import type {
  ReverseScanStore,
  ReverseScanJob,
  CreateReverseScanJobInput,
  UpdateReverseScanJobPatch,
  ReverseScanItem,
  CreateReverseScanItemInput,
  UpdateReverseScanItemPatch,
  ReverseScanItemReviewStatus,
} from "../domain/reverse-scan-types.js";

export class InMemoryReverseScanStore implements ReverseScanStore {
  private readonly jobs = new Map<string, ReverseScanJob>();
  private readonly items = new Map<string, ReverseScanItem>();

  async createReverseScanJob(input: CreateReverseScanJobInput): Promise<ReverseScanJob> {
    const id = input.id ?? `scan_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const job: ReverseScanJob = {
      id,
      accountId: input.accountId,
      storageId: input.storageId,
      targetCid: input.targetCid,
      category: input.category ?? "auto",
      status: "queued",
      totalFolders: 0,
      scannedFolders: 0,
      discoveredTitles: 0,
      autoIngestedTitles: 0,
      pendingReviewTitles: 0,
      currentStepMessage: "等待扫描队列调度...",
      progressPercent: 0,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(id, job);
    return structuredClone(job);
  }

  async getReverseScanJob(id: string): Promise<ReverseScanJob | null> {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : null;
  }

  async listReverseScanJobs(accountId: string, limit = 20): Promise<ReverseScanJob[]> {
    return Array.from(this.jobs.values())
      .filter((j) => j.accountId === accountId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((j) => structuredClone(j));
  }

  async updateReverseScanJob(id: string, patch: UpdateReverseScanJobPatch): Promise<void> {
    const existing = this.jobs.get(id);
    if (!existing) return;
    const updated: ReverseScanJob = {
      ...existing,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.totalFolders !== undefined ? { totalFolders: patch.totalFolders } : {}),
      ...(patch.scannedFolders !== undefined ? { scannedFolders: patch.scannedFolders } : {}),
      ...(patch.discoveredTitles !== undefined ? { discoveredTitles: patch.discoveredTitles } : {}),
      ...(patch.autoIngestedTitles !== undefined ? { autoIngestedTitles: patch.autoIngestedTitles } : {}),
      ...(patch.pendingReviewTitles !== undefined ? { pendingReviewTitles: patch.pendingReviewTitles } : {}),
      ...(patch.currentStepMessage !== undefined ? { currentStepMessage: patch.currentStepMessage } : {}),
      ...(patch.progressPercent !== undefined ? { progressPercent: patch.progressPercent } : {}),
      ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
      ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
      ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(id, updated);
  }

  async createReverseScanItem(input: CreateReverseScanItemInput): Promise<ReverseScanItem> {
    const id = input.id ?? `item_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const item: ReverseScanItem = {
      id,
      jobId: input.jobId,
      accountId: input.accountId,
      folderId: input.folderId,
      folderName: input.folderName,
      relativePath: input.relativePath,
      parsedTitle: input.parsedTitle ?? null,
      parsedYear: input.parsedYear ?? null,
      matchedTmdbId: input.matchedTmdbId ?? null,
      matchedMediaType: input.matchedMediaType ?? null,
      matchedTitle: input.matchedTitle ?? null,
      matchedPosterPath: input.matchedPosterPath ?? null,
      confidence: input.confidence ?? 0,
      reviewStatus: input.reviewStatus ?? "auto_accepted",
      discoveredFilesJson: input.discoveredFilesJson ?? "[]",
      reconciledSeasonsJson: input.reconciledSeasonsJson ?? null,
      errorReason: input.errorReason ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(id, item);
    return structuredClone(item);
  }

  async listReverseScanItems(jobId: string, reviewStatus?: ReverseScanItemReviewStatus): Promise<ReverseScanItem[]> {
    return Array.from(this.items.values())
      .filter((i) => i.jobId === jobId && (!reviewStatus || i.reviewStatus === reviewStatus))
      .sort((a, b) => b.confidence - a.confidence || b.createdAt.localeCompare(a.createdAt))
      .map((i) => structuredClone(i));
  }

  async updateReverseScanItem(id: string, patch: UpdateReverseScanItemPatch): Promise<void> {
    const existing = this.items.get(id);
    if (!existing) return;
    const updated: ReverseScanItem = {
      ...existing,
      ...(patch.reviewStatus !== undefined ? { reviewStatus: patch.reviewStatus } : {}),
      ...(patch.matchedTmdbId !== undefined ? { matchedTmdbId: patch.matchedTmdbId } : {}),
      ...(patch.matchedMediaType !== undefined ? { matchedMediaType: patch.matchedMediaType } : {}),
      ...(patch.matchedTitle !== undefined ? { matchedTitle: patch.matchedTitle } : {}),
      ...(patch.reconciledSeasonsJson !== undefined ? { reconciledSeasonsJson: patch.reconciledSeasonsJson } : {}),
      ...(patch.errorReason !== undefined ? { errorReason: patch.errorReason } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.items.set(id, updated);
  }
}
