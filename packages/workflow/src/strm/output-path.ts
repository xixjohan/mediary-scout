import { nativeFs as fs, nativePath as path } from "../domain/native-require.js";

const PROGRAM_ROOT = path.resolve(process.cwd());
const DATA_ROOT = path.join(PROGRAM_ROOT, "data");

/** Resolve the only supported STRM output format, relative to the program root. */
export function resolveStrmOutputPath(configuredPath: string): string {
  const value = configuredPath.trim().replace(/\\/g, "/");
  if (!value || path.isAbsolute(value) || /^[A-Za-z]:\//.test(value)) {
    throw new Error("STRM 输出目录必须是程序目录下的相对路径，例如 data/strm/movies");
  }

  const resolved = path.resolve(PROGRAM_ROOT, value);
  if (resolved !== DATA_ROOT && !resolved.startsWith(`${DATA_ROOT}${path.sep}`)) {
    throw new Error("STRM 输出目录必须位于程序目录的 data/ 下");
  }

  let current = DATA_ROOT;
  const segments = path.relative(DATA_ROOT, resolved).split(path.sep).filter(Boolean);
  if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const realRoot = fs.realpathSync(DATA_ROOT);
      const realCurrent = fs.realpathSync(current);
      if (realCurrent !== realRoot && !realCurrent.startsWith(`${realRoot}${path.sep}`)) {
        throw new Error("STRM 输出目录不能通过符号链接逃逸出程序 data 目录");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
  return resolved;
}

export function toStrmOutputConfigPath(absolutePath: string): string {
  const resolved = path.resolve(absolutePath);
  if (resolved !== DATA_ROOT && !resolved.startsWith(`${DATA_ROOT}${path.sep}`)) {
    throw new Error("STRM 输出目录必须位于程序目录的 data/ 下");
  }
  return path.relative(PROGRAM_ROOT, resolved).split(path.sep).join("/");
}

export function isValidStrmOutputPath(value: string): boolean {
  try {
    resolveStrmOutputPath(value);
    return true;
  } catch {
    return false;
  }
}
