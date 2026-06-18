/**
 * Build a protected StorageExecutor for a drive's brand. Replaces the worker's
 * old "assume 115" path: dispatch is by `connected_storages.provider`, so a 115
 * drive and a quark drive under the same account each get the right executor with
 * their own write scope (the drive's category CIDs).
 *
 * Lives here (not in storage-brands.ts) because building the 115 executor pulls
 * in env/protected-wrapper concerns the brand-identity registry must stay free of.
 */
import { createProtectedPan115CookieStorageExecutorFromEnv } from "./pan115-storage-factory.js";
import type { StorageExecutor } from "./ports.js";
import { QuarkCookieClient } from "./quark-cookie-client.js";
import { QuarkStorageExecutor } from "./quark-storage-executor.js";

export function createExecutorForBrand(input: {
  provider: string;
  cookie: string;
  /** The drive's write-scope directory ids (rootCid + Movies/TV/Anime). */
  scopeCids: string[];
  /** Base env for the 115 executor (guard pacing etc); defaults to process.env. */
  env?: Record<string, string | undefined>;
}): StorageExecutor {
  if (input.provider === "pan115") {
    const env = {
      ...(input.env ?? process.env),
      PAN115_COOKIE: input.cookie,
      ...(input.scopeCids.length > 0 ? { MEDIA_TRACK_115_WRITE_SCOPE_CIDS: input.scopeCids.join(",") } : {}),
    };
    return createProtectedPan115CookieStorageExecutorFromEnv({ env });
  }
  if (input.provider === "quark") {
    return new QuarkStorageExecutor({
      client: new QuarkCookieClient({ cookie: input.cookie }),
      writeScopeDirectoryIds: input.scopeCids,
    });
  }
  throw new Error(`unknown storage brand: ${input.provider}`);
}
