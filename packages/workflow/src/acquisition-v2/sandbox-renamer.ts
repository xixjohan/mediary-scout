import type { SimTreeFile, StorageV2 } from "./storage-115-simulator.js";

const SUBTITLE_NAME_PATTERN = /\.(srt|ass|ssa|sub|idx|vtt|sup|smi)$/i;

export async function executeSubtitleRenames(params: {
  storage: StorageV2;
  stagingDirectoryId: string;
  listTreeOf: (dirId: string) => Promise<SimTreeFile[]>;
  assertNotProtected: (ids: string[]) => void;
  renames: Array<{ fileId: string; newName: string }>;
}): Promise<{ renamed: string[]; errors?: Array<{ fileId: string; error: string }> }> {
  const { storage, stagingDirectoryId, listTreeOf, assertNotProtected, renames } = params;
  if (renames.length === 0) {
    throw new Error(
      "SANDBOX_EMPTY_RENAMES: renames must not be empty — decide every subtitle↔episode pairing first (至少一项)",
    );
  }
  const staging = await listTreeOf(stagingDirectoryId);
  const renamed: string[] = [];
  const errors: Array<{ fileId: string; error: string }> = [];

  for (const { fileId, newName } of renames) {
    try {
      const target = staging.find((file) => file.id === fileId);
      if (!target) {
        throw new Error(`SANDBOX_FILE_NOT_IN_STAGING: ${fileId} is not in this task's staging`);
      }
      if (!target.isSubtitle) {
        throw new Error(
          `SANDBOX_NOT_A_SUBTITLE: ${fileId} is not a subtitle file; only subtitles may be renamed`,
        );
      }
      assertNotProtected([fileId]);
      if (/[\\/]/.test(newName)) {
        throw new Error(
          `SANDBOX_INVALID_SUBTITLE_NAME: newName must be a bare filename without path separators`,
        );
      }
      if (!SUBTITLE_NAME_PATTERN.test(newName)) {
        throw new Error(
          `SANDBOX_INVALID_SUBTITLE_NAME: newName must keep a subtitle extension (.srt/.ass/.ssa/.sub/.idx/.vtt/.sup/.smi)`,
        );
      }
      await storage.renameFile({
        directoryId: stagingDirectoryId,
        fileId,
        newName,
      });
      renamed.push(newName);
    } catch (error) {
      errors.push({ fileId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { renamed, ...(errors.length > 0 ? { errors } : {}) };
}

export async function executeTargetFileRenames(params: {
  storage: StorageV2;
  targetDir: string;
  listTreeOf: (dirId: string) => Promise<SimTreeFile[]>;
  renames: Array<{ fileId: string; newName: string }>;
}): Promise<{ renamed: string[]; errors?: Array<{ fileId: string; error: string }> }> {
  const { storage, targetDir, listTreeOf, renames } = params;
  const targetFiles = await listTreeOf(targetDir);
  const renamed: string[] = [];
  const errors: Array<{ fileId: string; error: string }> = [];

  for (const { fileId, newName } of renames) {
    try {
      const target = targetFiles.find((f) => f.id === fileId);
      if (!target) {
        throw new Error(`SANDBOX_FILE_NOT_IN_TARGET: ${fileId} is not in directory ${targetDir}`);
      }
      if (/[\\/]/.test(newName)) {
        throw new Error(`SANDBOX_INVALID_FILE_NAME: newName must be a bare filename without path separators`);
      }
      await storage.renameFile({
        directoryId: targetDir,
        fileId,
        newName,
      });
      renamed.push(newName);
    } catch (error) {
      errors.push({ fileId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { renamed, ...(errors.length > 0 ? { errors } : {}) };
}
