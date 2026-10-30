import { TokenCredential } from "@media-track/contracts";
import { getStorageBrand, isRegisteredStorageProvider } from "@media-track/workflow";

export function extractStorageCredential(
  provider: string,
  payload: unknown,
): { cookie: string; credential: TokenCredential | null } {
  const brand = isRegisteredStorageProvider(provider) ? getStorageBrand(provider) : null;
  if (brand?.authKind === "token") {
    const blob = (payload ?? {}) as Record<string, unknown>;
    const requiredKeys = brand.requiredCredentialKeys ?? [];
    const ok =
      requiredKeys.length > 0 &&
      requiredKeys.every((key) => typeof blob[key] === "string" && (blob[key] as string).trim().length > 0);
    return ok ? { cookie: "", credential: blob } : { cookie: "", credential: null };
  }
  const cookie = (payload as { cookie?: string } | null)?.cookie?.trim() ?? "";
  return { cookie, credential: null };
}
