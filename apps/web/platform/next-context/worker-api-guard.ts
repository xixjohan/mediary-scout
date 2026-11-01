import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../lib/demo-mode";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

let cachedResolvedSecret: string | null | undefined = undefined;

export function _resetWorkerSecretCacheForTesting(): void {
  cachedResolvedSecret = undefined;
}

export function resolveInternalWorkerSecret(): string | null {
  const envSecret = process.env.MEDIA_TRACK_WORKER_SECRET?.trim();
  if (envSecret) {
    return envSecret;
  }

  if (cachedResolvedSecret !== undefined) return cachedResolvedSecret;

  try {
    const sqlitePath = process.env.MEDIA_TRACK_SQLITE_PATH?.trim() || join(process.cwd(), "data", "mediary.db");
    const dir = dirname(sqlitePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tokenFile = join(dir, ".worker_secret");
    if (existsSync(tokenFile)) {
      const read = readFileSync(tokenFile, "utf-8").trim();
      if (read) {
        cachedResolvedSecret = read;
        return read;
      }
    }
    const generated = randomBytes(32).toString("hex");
    try {
      writeFileSync(tokenFile, generated, { mode: 0o600 });
      cachedResolvedSecret = generated;
      return generated;
    } catch {
      cachedResolvedSecret = generated;
      return generated;
    }
  } catch {
    cachedResolvedSecret = null;
    return null;
  }
}

export function workerApiGuard(request: NextRequest): NextResponse | null {
  if (isDemoMode()) {
    return NextResponse.json({ error: "demo mode is read-only" }, { status: 403 });
  }

  const incoming = request.headers.get("x-media-track-worker-secret")?.trim();
  const envSecret = process.env.MEDIA_TRACK_WORKER_SECRET?.trim();

  // 1. If explicit env secret is configured, strictly enforce matching
  if (envSecret) {
    if (incoming !== envSecret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return null;
  }

  // 2. In multi-user mode, auto-provision and enforce internal secret
  if (process.env.MEDIA_TRACK_MULTI_USER === "1") {
    const autoSecret = resolveInternalWorkerSecret();
    if (!autoSecret || incoming !== autoSecret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return null;
  }

  // 3. Single-user mode backwards compatibility: allow secretless internal cron
  return null;
}

