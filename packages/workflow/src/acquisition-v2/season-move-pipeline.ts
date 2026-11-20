import { canonicalEpisodeFileName, cleanMediaTitle, episodeCodeFromFileName } from "../domain/episode-code.js";
import type { SimTreeFile, StorageV2 } from "./storage-115-simulator.js";
import type { PolicyRejectReason, PolicyResource } from "../execution/subscription-policy.js";

export function evaluatePolicyFiles(params: {
  files: readonly SimTreeFile[];
  policyFileValidator?: ((file: PolicyResource) => PolicyRejectReason | null) | undefined;
  isMovieRun: boolean;
  onBlockEpisode: (blockedCode: string) => void;
}): Array<{ file: SimTreeFile; reason: PolicyRejectReason }> {
  if (!params.policyFileValidator) return [];
  const rejected: Array<{ file: SimTreeFile; reason: PolicyRejectReason }> = [];
  for (const file of params.files) {
    if (!file.isVideo) continue;
    const reason = params.policyFileValidator({ name: file.path, episodeCode: file.parsed?.episodeCode ?? null });
    if (!reason) continue;
    rejected.push({ file, reason });
    const blockedCode = params.isMovieRun ? "MOVIE" : file.parsed?.episodeCode ?? "POLICY_UNKNOWN_FILE";
    params.onBlockEpisode(blockedCode);
  }
  return rejected;
}

export function throwPolicyFileRejection(rejected: readonly { file: SimTreeFile; reason: PolicyRejectReason }[]): never {
  const details = rejected
    .slice(0, 8)
    .map(({ file, reason }) => `${file.parsed?.episodeCode ?? "集数未知"} ${file.path} (${reason})`)
    .join("; ");
  const more = rejected.length > 8 ? `; 另有 ${rejected.length - 8} 个文件` : "";
  throw new Error(
    `SUBSCRIPTION_POLICY_FILE_REJECTED: configured policy rejects ${rejected.length} video file(s): ${details}${more}. Do not mark these episodes; remove rejected files from staging or select compliant files, then retry.`,
  );
}

export type SubmissionState = "in_flight" | "landed" | "unresolved";

export function sameLinkWhy(hold: { owner: string; state: SubmissionState }): string {
  if (hold.state === "landed") {
    return "whose files already landed this run — inspect them instead of transferring again";
  }
  if (hold.state === "in_flight") {
    return "which is being transferred right now — wait for that result and inspect it instead of transferring again";
  }
  return "which was already submitted this run and left nothing landed (未决 / unresolved) — read the landing point instead of transferring again";
}

export function sameLinkError(candidateId: string, hold: { owner: string; state: SubmissionState }): string {
  return `SANDBOX_SAME_LINK: ${candidateId} is the same link as ${hold.owner}, ${sameLinkWhy(hold)}`;
}

export function sameLinkNote(hold: { owner: string; state: SubmissionState }): string {
  if (hold.state === "landed") return `same link as ${hold.owner} already landed this run`;
  return `same link as ${hold.owner}, ${sameLinkWhy(hold)}`;
}

export async function assertPolicyFilesInTargets(params: {
  policyFileValidator?: ((file: PolicyResource) => PolicyRejectReason | null) | undefined;
  storage?: StorageV2 | undefined;
  targetDirIds: readonly string[];
  listTreeOf: (directoryId: string) => Promise<SimTreeFile[]>;
  materializedBy: ReadonlyMap<string, string>;
  isMovieRun: boolean;
  onBlockEpisode: (code: string) => void;
}): Promise<void> {
  if (!params.policyFileValidator || !params.storage) return;
  const rejected: Array<{ file: SimTreeFile; reason: PolicyRejectReason }> = [];
  for (const directoryId of params.targetDirIds) {
    const files = await params.listTreeOf(directoryId);
    rejected.push(...evaluatePolicyFiles({
      files: files.filter((file) => params.materializedBy.has(file.id)),
      policyFileValidator: params.policyFileValidator,
      isMovieRun: params.isMovieRun,
      onBlockEpisode: params.onBlockEpisode,
    }));
  }
  if (rejected.length > 0) throwPolicyFileRejection(rejected);
}

/**
 * Cross-season validation: prevents episodes of Season N (e.g. S02) from
 * being erroneously moved into Season M (e.g. Season 01).
 */
export function validateCrossSeasonMoves(params: {
  season?: number | undefined;
  fileIds: readonly string[];
  stagingTree: readonly SimTreeFile[];
}): void {
  if (params.season === undefined) return;
  for (const fileId of params.fileIds) {
    const file = params.stagingTree.find((f) => f.id === fileId);
    if (!file || !file.isVideo) continue;
    const fileName = file.path.split("/").pop() ?? "";
    const explicitSeasonMatch = /[Ss](\d{1,2})[Ee]\d+/i.exec(fileName) ?? /第\s*(\d+)\s*季/.exec(fileName);
    if (explicitSeasonMatch?.[1]) {
      const detectedSeason = Number(explicitSeasonMatch[1]);
      if (detectedSeason !== params.season) {
        throw new Error(
          `CROSS_SEASON_VIOLATION: file "${fileName}" belongs to Season ${detectedSeason}, refusing to move into Season ${params.season}`,
        );
      }
    }
  }
}

function resolveStandardizedFileName(
  file: SimTreeFile,
  origName: string,
  showTitle: string,
  season: number,
): string | null {
  const ep = episodeCodeFromFileName(origName, season);
  if (!ep) return null;

  if (file.isVideo) {
    return canonicalEpisodeFileName({
      title: showTitle,
      episodeCode: ep,
      sourceName: origName,
      preserveMetadata: true,
    });
  }

  if (file.isSubtitle) {
    const ext = origName.slice(origName.lastIndexOf("."));
    const isInfix = origName.includes(".sc.") ? ".sc" : origName.includes(".tc.") ? ".tc" : "";
    return `${cleanMediaTitle(showTitle)} - ${ep}${isInfix}${ext}`;
  }

  return null;
}

/**
 * Standardized media renamer: automatically normalizes media filenames
 * (videos and matching subtitles) landed in the season folder according to
 * Emby/Jellyfin/Plex canonical conventions: "{Show} - S{ss}E{ee} [{quality}].{ext}".
 */
export async function standardizeMovedSeasonFiles(params: {
  storage: StorageV2;
  targetDir: string;
  movedFileIds: readonly string[];
  stagingTree: readonly SimTreeFile[];
  showTitle?: string | undefined;
  season?: number | undefined;
}): Promise<void> {
  const { storage, targetDir, movedFileIds, stagingTree, showTitle, season } = params;
  if (!showTitle || showTitle === "Show") return;

  for (const fileId of movedFileIds) {
    const file = stagingTree.find((f) => f.id === fileId);
    if (!file) continue;
    const origName = file.path.split("/").pop() ?? "";
    const standardName = resolveStandardizedFileName(file, origName, showTitle, season ?? 1);
    if (standardName && standardName !== origName) {
      try {
        await storage.renameFile({
          directoryId: targetDir,
          fileId,
          newName: standardName,
        });
      } catch {
        // Non-fatal if drive rename fails
      }
    }
  }
}
