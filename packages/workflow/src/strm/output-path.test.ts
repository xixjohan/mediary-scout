import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isValidStrmOutputPath, resolveStrmOutputPath, toStrmOutputConfigPath } from "./output-path.js";

describe("STRM output path contract", () => {
  const links: string[] = [];

  afterEach(() => {
    for (const link of links.splice(0)) fs.rmSync(link, { force: true });
  });

  it("resolves program data relative paths and returns normalized config paths", () => {
    expect(resolveStrmOutputPath("data/strm/movies")).toBe(path.join(process.cwd(), "data", "strm", "movies"));
    expect(toStrmOutputConfigPath(path.join(process.cwd(), "data", "strm", "tv"))).toBe("data/strm/tv");
  });

  it.each(["/data/strm/movies", "../outside", "data/../../outside", "", "C:/temp/strm"])("rejects invalid path %s", (value) => {
    expect(isValidStrmOutputPath(value)).toBe(false);
  });

  it("rejects symlinks escaping the data root", () => {
    const dataRoot = path.join(process.cwd(), "data");
    fs.mkdirSync(dataRoot, { recursive: true });
    const link = path.join(dataRoot, `strm-link-${Date.now()}`);
    fs.symlinkSync(os.tmpdir(), link, "junction");
    links.push(link);
    expect(() => resolveStrmOutputPath(path.relative(process.cwd(), path.join(link, "movies")))).toThrow("符号链接");
  });
});
