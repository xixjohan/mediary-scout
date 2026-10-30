export const DEFAULT_LOCAL_ORIGIN = "http://localhost:3300";

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:(\d{1,5}))?$/i;

export function resolveRequestOrigin(headers: {
  get(name: string): string | null;
}): string {
  return resolveRequestOriginOrNull(headers) ?? DEFAULT_LOCAL_ORIGIN;
}

export function resolveRequestOriginOrNull(headers: {
  get(name: string): string | null;
}): string | null {
  const protoRaw = headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase()
    .replace(/:$/, "");
  const proto = protoRaw === "https" ? "https" : "http";
  const hostRaw = (
    headers.get("x-forwarded-host")?.split(",")[0] ?? headers.get("host")
  )?.trim();
  const match = hostRaw ? HOST_RE.exec(hostRaw) : null;
  if (match) {
    const port = match[3];
    if (port !== undefined) {
      const n = Number(port);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
    }
    return `${proto}://${hostRaw}`;
  }
  return null;
}
