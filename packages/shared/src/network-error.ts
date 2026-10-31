/**
 * 展开 fetch / 网络错误中的 cause（如 connect ECONNREFUSED、ETIMEDOUT），
 * 避免向调用方或前端仅抛出泛化的 "TypeError: fetch failed"。
 */
export function formatNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause) {
      const causeCode =
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        typeof (cause as { code: unknown }).code === "string"
          ? ` [${(cause as { code: string }).code}]`
          : "";
      const causeMsg = cause instanceof Error ? cause.message : String(cause);
      return `${error.message}${causeCode} (${causeMsg})`;
    }
    return error.message;
  }
  return String(error);
}
