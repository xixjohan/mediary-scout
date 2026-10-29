import type { ResourceSnapshotV2 } from "./fake-provider.js";
import type { TaskSandbox } from "./sandbox.js";

export interface CandidateLike {
  id: string;
  title: string;
  seeders?: number;
  sizeBytes?: number;
}

/**
 * 确定性规则降级选择器（Deterministic Rule Fallback Strategy）。
 */

function scoreNegativeKeywords(title: string): number {
  if (title.includes("trailer") || title.includes("预告") || title.includes("sample") || title.includes("花絮")) {
    return -100;
  }
  return 0;
}

function detectResolution(title: string): "4k" | "1080p" | "720p" | "other" {
  if (/(?:4k|2160p|uhd)/i.test(title)) return "4k";
  if (/(?:1080p|fhd)/i.test(title)) return "1080p";
  if (/(?:720p|hd)/i.test(title)) return "720p";
  return "other";
}

const DEFAULT_SCORES: Record<string, number> = { "4k": 50, "1080p": 40, "720p": 20, other: 0 };
const RESOLUTION_SCORES: Record<string, Record<string, number>> = {
  "4K": { "4k": 60, "1080p": 40, "720p": 20, other: 0 },
  "1080p": { "1080p": 60, "4k": 45, "720p": 20, other: 0 },
};

function scoreResolution(title: string, qualityPreference: string): number {
  const res = detectResolution(title);
  const matrix = RESOLUTION_SCORES[qualityPreference] ?? DEFAULT_SCORES;
  return matrix[res] ?? 0;
}

function scoreBonusFeatures(title: string, candidate: CandidateLike): number {
  let score = 0;
  if (title.includes("内嵌") || title.includes("中字") || title.includes("简繁") || title.includes("双语")) {
    score += 15;
  }
  const seeders = typeof candidate.seeders === "number" ? candidate.seeders : undefined;
  if (seeders !== undefined && seeders > 0) {
    score += Math.min(seeders * 2, 20);
  }
  const sizeBytes = typeof candidate.sizeBytes === "number" ? candidate.sizeBytes : undefined;
  if (sizeBytes !== undefined) {
    const gb = sizeBytes / (1024 * 1024 * 1024);
    if (gb >= 1.0 && gb <= 60.0) score += 10;
  }
  return score;
}

export function scoreCandidate(candidate: CandidateLike, qualityPreference = "4K"): number {
  const title = (candidate.title || "").toLowerCase();
  return (
    scoreNegativeKeywords(title) +
    scoreResolution(title, qualityPreference) +
    scoreBonusFeatures(title, candidate)
  );
}

export function pickBestCandidate<T extends CandidateLike>(
  candidates: readonly T[],
  qualityPreference = "4K",
): T | null {
  if (candidates.length === 0) return null;
  let bestCandidate: T | null = null;
  let highestScore = -Infinity;

  for (const c of candidates) {
    const score = scoreCandidate(c, qualityPreference);
    if (score > highestScore) {
      highestScore = score;
      bestCandidate = c;
    }
  }

  return highestScore > 0 ? bestCandidate : candidates[0] ?? null;
}

async function organizeMediaAfterTransfer(sandbox: TaskSandbox, isMovie: boolean): Promise<void> {
  if (isMovie) {
    try {
      await sandbox.flattenMovie?.();
    } catch {
      // 已经在顶层目录时略过
    }
    await sandbox.markObtained({ codes: ["MOVIE"] });
    await sandbox.finish();
    return;
  }

  const staging = await sandbox.inspectStaging();
  const videoFiles = staging.filter((f) => f.path.match(/\.(mkv|mp4|avi|ts|mov)$/i));
  if (videoFiles.length > 0) {
    await sandbox.moveToSeason({
      moves: [{ season: 1, fileIds: videoFiles.map((f) => f.id) }],
    });
    await sandbox.markObtained({
      codes: videoFiles.map((_, idx) => `S01E${String(idx + 1).padStart(2, "0")}`),
    });
  }
  try {
    await sandbox.discardStaging?.();
  } catch {
    // 暂存清空保护略过
  }
  await sandbox.finish();
}

async function resolveSnapshots(sandbox: TaskSandbox, keyword?: string): Promise<readonly ResourceSnapshotV2[]> {
  let snapshots = sandbox.getObservedSnapshots?.() ?? [];
  if (snapshots.length === 0 && keyword?.trim()) {
    try {
      await sandbox.searchResources(keyword.trim());
      snapshots = sandbox.getObservedSnapshots?.() ?? [];
    } catch {
      // 搜索失败忽略
    }
  }
  return snapshots;
}

/**
 * 执行确定性规则降级转存流程。
 */
export async function executeDeterministicFallback(
  sandbox: TaskSandbox,
  options: {
    movie: boolean;
    qualityPreference?: string;
    keyword?: string;
  },
): Promise<{ success: boolean; candidateTitle?: string; reason?: string }> {
  try {
    const snapshots = await resolveSnapshots(sandbox, options.keyword);
    if (snapshots.length === 0) {
      return { success: false, reason: "沙盒内暂无可用的资源快照进行规则降级" };
    }

    const allCandidates = snapshots.flatMap((snap) =>
      snap.candidates.map((cand) => ({ snapshot: snap, candidate: cand })),
    );
    if (allCandidates.length === 0) {
      return { success: false, reason: "快照中候选资源为空" };
    }

    const best = pickBestCandidate(allCandidates.map((i) => i.candidate), options.qualityPreference ?? "4K");
    if (!best) {
      return { success: false, reason: "未找到评分合格的候选资源" };
    }

    const matched = allCandidates.find((i) => i.candidate.id === best.id);
    if (!matched) {
      return { success: false, reason: "候选元数据关联缺失" };
    }

    await sandbox.transferCandidate({ snapshotId: matched.snapshot.id, candidateId: best.id });
    await organizeMediaAfterTransfer(sandbox, options.movie);

    return { success: true, candidateTitle: best.title };
  } catch (err) {
    return { success: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
