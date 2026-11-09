import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPlayPath,
  buildPlayUrl,
  buildSignedPlayUrl,
  verifyStrmPlayToken,
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

  it("builds correct play path and play url based on taskId without mode pollution", () => {
    const p1 = buildPlayPath("strm_task_1", "file_123");
    expect(p1).toBe("/api/strm/play/strm_task_1/file_123");

    const p2 = buildPlayPath("strm_task_1", "file_123", "Episode 01.mp4");
    expect(p2).toBe("/api/strm/play/strm_task_1/file_123?name=Episode%2001.mp4");

    const url = buildPlayUrl("http://192.168.1.100:3000/", "strm_task_1", "f1", "test.mkv");
    expect(url).toBe("http://192.168.1.100:3000/api/strm/play/strm_task_1/f1?name=test.mkv");
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

  it("generates signed play URL and verifies HMAC token signature and expiration", () => {
    const baseUrl = "http://192.168.1.100:3000";
    const taskId = "task_video_1";
    const fileId = "file_video_99";
    const secret = "test-secret-key-12345";

    const signedUrl = buildPlayUrl(baseUrl, taskId, fileId, "movie.mkv", {
      sign: true,
      ttlSeconds: 3600,
      secret,
    });

    const parsed = new URL(signedUrl);
    expect(parsed.pathname).toBe("/api/strm/play/task_video_1/file_video_99");
    expect(parsed.searchParams.get("name")).toBe("movie.mkv");
    const token = parsed.searchParams.get("token");
    const exp = Number(parsed.searchParams.get("exp"));
    expect(token).toBeTruthy();
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // 1. 正常验证通过
    const validCheck = verifyStrmPlayToken({ taskId, fileId, token, expiresAtEpochSeconds: exp, secret });
    expect(validCheck.valid).toBe(true);

    // 2. 篡改 fileId -> 拒绝
    const tamperedFile = verifyStrmPlayToken({ taskId, fileId: "file_tampered", token, expiresAtEpochSeconds: exp, secret });
    expect(tamperedFile.valid).toBe(false);
    expect(tamperedFile.reason).toBe("invalid_signature");

    // 3. 过期时间伪造或超时 -> 拒绝
    const expiredCheck = verifyStrmPlayToken({
      taskId,
      fileId,
      token,
      expiresAtEpochSeconds: exp,
      secret,
      nowEpochSeconds: exp + 10,
    });
    expect(expiredCheck.valid).toBe(false);
    expect(expiredCheck.reason).toBe("token_expired");
  });
});