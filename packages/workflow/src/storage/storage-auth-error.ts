import { isGuangYaAuthError } from "./guangya-client.js";
import { isPan115AuthError } from "./pan115-cookie-client.js";
import { isPan123AuthError } from "./pan123-client.js";
import { isQuarkAuthError } from "./quark-cookie-client.js";
import { isTianyiAuthError } from "./tianyi-client.js";

/** Brand netdisk auth failures only (cookie/token dead) — never LLM Unauthorized
 *  or plain Errors. The worker freezes the run's drive on these; every layer in
 *  between must let them through untouched (never soften one into a per-file
 *  "failed" — a dead credential is not a landing miss). */
export function isBrandStorageAuthError(error: unknown): boolean {
  return (
    isPan115AuthError(error) ||
    // 夸克 + UC share ONE error class (same family protocol, same 31001 code).
    isQuarkAuthError(error) ||
    isGuangYaAuthError(error) ||
    isTianyiAuthError(error) ||
    isPan123AuthError(error)
  );
}

export async function maybeFreezeOnBrandAuthError(input: {
  connectedStorageId: string | null | undefined;
  error: unknown;
  onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>;
}): Promise<void> {
  const { connectedStorageId, error, onAuthErrorFreeze } = input;
  if (!onAuthErrorFreeze || !connectedStorageId || !isBrandStorageAuthError(error)) {
    return;
  }
  const reason = error instanceof Error ? error.message : String(error);
  try {
    await onAuthErrorFreeze(connectedStorageId, reason);
  } catch (freezeError) {
    console.error(
      `[media-track] onAuthErrorFreeze failed for ${connectedStorageId}: ${String(freezeError)}`,
    );
  }
}
