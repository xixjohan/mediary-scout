import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isValidStrmOutputPath,
  resolveDataRoot,
  resolveStrmOutputPath,
  toStrmOutputConfigPath,
} from "./output-path.js";

describe("STRM output path contract", () => {
  const links: string[] = [];
  const originalEnv = process.env.MEDIA_TRACK_DATA_DIR;

  beforeEach(() => {
    delete process.env.MEDIA_TRACK_DATA_DIR;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.MEDIA_TRACK_DATA_DIR = originalEnv;
    } else {
      delete process.env.MEDIA_TRACK_DATA_DIR;
    }
    for (const link of links.splice(0)) fs.rmSync(link, { force: true });
  });

  it("resolves program data relative paths and returns normalized config paths", () => {
    const dataRoot = resolveDataRoot();
    expect(resolveStrmOutputPath("data/strm/movies")).toBe(path.join(dataRoot, "strm", "movies"));
    expect(resolveStrmOutputPath("strm/movies")).toBe(path.join(dataRoot, "strm", "movies"));
    expect(toStrmOutputConfigPath(path.join(dataRoot, "strm", "tv"))).toBe("data/strm/tv");
  });

  it("accepts valid absolute paths under data root and resolves /app/data standard prefix", () => {
    const dataRoot = resolveDataRoot();
    const absPath = path.join(dataRoot, "strm", "tv");
    expect(isValidStrmOutputPath(absPath)).toBe(true);
    expect(resolveStrmOutputPath(absPath)).toBe(absPath);
    expect(toStrmOutputConfigPath(absPath)).toBe("data/strm/tv");

    // Standard /app/data prefix resolves to current dataRoot
    expect(resolveStrmOutputPath("/app/data/strm/tv")).toBe(path.join(dataRoot, "strm", "tv"));
    expect(isValidStrmOutputPath("/app/data/strm/movies")).toBe(true);
  });

  it("respects MEDIA_TRACK_DATA_DIR environment variable override", () => {
    const customDir = path.join(os.tmpdir(), `custom-data-${Date.now()}`);
    fs.mkdirSync(customDir, { recursive: true });
    try {
      process.env.MEDIA_TRACK_DATA_DIR = customDir;
      expect(resolveDataRoot()).toBe(path.resolve(customDir));
      expect(resolveStrmOutputPath("strm/anime")).toBe(path.join(path.resolve(customDir), "strm", "anime"));
      expect(resolveStrmOutputPath(path.join(customDir, "strm", "anime"))).toBe(
        path.join(path.resolve(customDir), "strm", "anime"),
      );
    } finally {
      fs.rmSync(customDir, { recursive: true, force: true });
    }
  });

  it.each(["../outside", "data/../../outside", "", "/invalid/absolute/path", "C:/temp/outside"])("rejects invalid path %s", (value) => {
    expect(isValidStrmOutputPath(value)).toBe(false);
  });

  it("rejects symlinks escaping the data root", () => {
    const dataRoot = resolveDataRoot();
    fs.mkdirSync(dataRoot, { recursive: true });
    const link = path.join(dataRoot, `strm-link-${Date.now()}`);
    fs.symlinkSync(os.tmpdir(), link, "junction");
    links.push(link);
    expect(() => resolveStrmOutputPath(path.join(link, "movies"))).toThrow("符号链接");
  });
});
