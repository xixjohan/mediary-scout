import { nativeFs as fs, nativePath as path } from "../domain/native-require.js";

/**
 * 权威解析应用数据根目录（SSOT Data Root）。
 * 彻底防御 Next.js Standalone / Monorepo 运行时的 process.cwd() 漂移到 apps/web 的漏洞。
 */
export function resolveDataRoot(): string {
  const envDir = process.env.MEDIA_TRACK_DATA_DIR?.trim();
  if (envDir) return path.resolve(envDir);

  if (process.platform === "linux") {
    try {
      if (fs.existsSync("/app/data")) {
        return path.resolve("/app/data");
      }
    } catch {
      // ignore
    }
  }

  let current = path.resolve(process.cwd());
  while (true) {
    const candidateData = path.join(current, "data");
    const parentDir = path.dirname(current);

    if (path.basename(parentDir) === "apps" || path.basename(parentDir) === "packages") {
      current = path.dirname(parentDir);
      continue;
    }

    if (fs.existsSync(candidateData)) {
      return path.resolve(candidateData);
    }

    if (parentDir === current) break;
    current = parentDir;
  }

  return path.resolve(process.cwd(), "data");
}

function resolveCandidatePath(value: string, dataRoot: string): string {
  if (value === "/app/data" || value === "data") return dataRoot;
  if (value.startsWith("/app/data/")) return path.resolve(dataRoot, value.slice("/app/data/".length));
  if (value.startsWith("data/")) return path.resolve(dataRoot, value.slice("data/".length));
  if (path.isAbsolute(value) || /^[A-Za-z]:\//.test(value)) return path.resolve(value);
  return path.resolve(dataRoot, value);
}

function assertNoSymlinkEscape(normalizedDataRoot: string, normalizedResolved: string): void {
  let current = normalizedDataRoot;
  const segments = path.relative(normalizedDataRoot, normalizedResolved).split(path.sep).filter(Boolean);
  if (!fs.existsSync(normalizedDataRoot)) fs.mkdirSync(normalizedDataRoot, { recursive: true });
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const realRoot = fs.realpathSync(normalizedDataRoot);
      const realCurrent = fs.realpathSync(current);
      if (realCurrent !== realRoot && !realCurrent.startsWith(`${realRoot}${path.sep}`)) {
        throw new Error("STRM 输出目录不能通过符号链接逃逸出数据目录");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
}

/** Resolve the supported STRM output format. Supports both absolute paths under data root and relative paths. */
export function resolveStrmOutputPath(configuredPath: string): string {
  const value = configuredPath.trim().replace(/\\/g, "/");
  if (!value) {
    throw new Error("STRM 输出目录不能为空");
  }

  const dataRoot = resolveDataRoot();
  const normalizedDataRoot = path.resolve(dataRoot);
  const normalizedResolved = path.resolve(resolveCandidatePath(value, dataRoot));

  if (
    normalizedResolved !== normalizedDataRoot &&
    !normalizedResolved.startsWith(`${normalizedDataRoot}${path.sep}`)
  ) {
    throw new Error(`STRM 输出目录必须位于数据目录 (${normalizedDataRoot}) 之下`);
  }

  assertNoSymlinkEscape(normalizedDataRoot, normalizedResolved);
  return normalizedResolved;
}

export function toStrmOutputConfigPath(absolutePath: string): string {
  const dataRoot = resolveDataRoot();
  const resolved = path.resolve(absolutePath);
  const normalizedDataRoot = path.resolve(dataRoot);
  if (resolved !== normalizedDataRoot && !resolved.startsWith(`${normalizedDataRoot}${path.sep}`)) {
    throw new Error(`STRM 输出目录必须位于数据目录 (${normalizedDataRoot}) 之下`);
  }
  const rel = path.relative(normalizedDataRoot, resolved).split(path.sep).join("/");
  if (normalizedDataRoot === "/app/data" || normalizedDataRoot.startsWith("/app/data/")) {
    return rel ? `/app/data/${rel}` : "/app/data";
  }
  return rel ? `data/${rel}` : "data";
}

export function isValidStrmOutputPath(value: string): boolean {
  try {
    resolveStrmOutputPath(value);
    return true;
  } catch {
    return false;
  }
}
