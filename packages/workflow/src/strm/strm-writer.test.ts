import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPlayPath,
  buildPlayUrl,
  removeStrmFile,
  safeDirSegments,
  safeStem,
  writeStrmFile,
} from "./strm-writer.js";

describe("strm-writer", () => {
  const dirs: string[] = [];
  const makeTempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strm-writer-test-"));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  });

  it("sanitizes file and directory names safely", () => {
    expect(safeStem("Breaking: Bad? [2008]")).toBe("Breaking_ Bad_ [2008]");
    expect(safeStem("  普通中文 片名 / 2026  ")).toBe("普通中文 片名 _ 2026");
    expect(safeStem("..")).toBe("_");
    expect(safeStem("")).toBe("_");
    expect(safeDirSegments("TV/Show: 1/Season 01")).toEqual(["TV", "Show_ 1", "Season 01"]);
  });

  it("builds correct play path and play url", () => {
    const p1 = buildPlayPath("cs_115", "file_123");
    expect(p1).toBe("/api/strm/play/cs_115/file_123");

    const p2 = buildPlayPath("cs_115", "file_123", "Episode 01.mp4");
    expect(p2).toBe("/api/strm/play/cs_115/file_123?name=Episode%2001.mp4");

    const url = buildPlayUrl("http://192.168.1.100:3000/", "cs_115", "f1", "test.mkv");
    expect(url).toBe("http://192.168.1.100:3000/api/strm/play/cs_115/f1?name=test.mkv");
  });

  it("writes .strm file with proper directory creation and trailing newline", async () => {
    const base = makeTempDir();
    const strmPath = path.join(base, "TV", "My Show", "Season 01", "S01E01.strm");

    await writeStrmFile({
      targetFilePath: strmPath,
      playUrl: "http://192.168.1.100:3000/api/strm/play/cs_1/f1",
    });

    expect(fs.existsSync(strmPath)).toBe(true);
    const content = fs.readFileSync(strmPath, "utf8");
    expect(content).toBe("http://192.168.1.100:3000/api/strm/play/cs_1/f1\n");
  });

  it("removes .strm file and cleans up empty parent directories", async () => {
    const base = makeTempDir();
    const strmPath = path.join(base, "Movies", "SubDir", "Movie.strm");

    await writeStrmFile({
      targetFilePath: strmPath,
      playUrl: "http://192.168.1.100:3000/api/strm/play/cs_1/f1",
    });

    expect(fs.existsSync(strmPath)).toBe(true);

    const removed = await removeStrmFile(strmPath, true);
    expect(removed).toBe(true);
    expect(fs.existsSync(strmPath)).toBe(false);
    // SubDir should have been cleaned up because it was empty
    expect(fs.existsSync(path.join(base, "Movies", "SubDir"))).toBe(false);
  });
});
