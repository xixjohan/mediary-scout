import type { VerifiedFile } from "../domain.js";
import { episodeCodeFromFileName } from "../domain/episode-code.js";
import type { SimTreeFile } from "./storage-115-simulator.js";

export interface VerifiedSeasonInventory {
  seasonNumber: number;
  directoryId: string;
  files: VerifiedFile[];
}
export type VerifiedInventorySink = (inventory: VerifiedSeasonInventory) => Promise<void>;

/** Use the target tree already re-read after moving; no additional drive call. */
export function verifiedSeasonInventory(seasonNumber: number, directoryId: string, tree: SimTreeFile[]): VerifiedSeasonInventory {
  const prefix = `S${String(seasonNumber).padStart(2, "0")}E`;
  const files = tree.flatMap((file): VerifiedFile[] => {
    if (!file.isVideo || file.sizeBytes <= 0) return [];
    const name = file.path.split(/[\\/]/).at(-1) ?? "";
    const episodeCode = episodeCodeFromFileName(name, seasonNumber);
    if (!episodeCode?.startsWith(prefix)) return [];
    return [{ id: file.id, providerFileId: file.id, storageDirectoryId: directoryId,
      name, relativePath: file.path, sizeBytes: file.sizeBytes, episodeCode }];
  });
  return { seasonNumber, directoryId, files };
}
