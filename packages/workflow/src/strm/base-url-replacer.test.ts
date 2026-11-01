import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeBaseUrl,
  replaceBaseUrlInFiles,
  replaceBaseUrlInLine,
} from "./base-url-replacer.js";

describe("base-url-replacer", () => {
  const dirs: string[] = [];
  const makeTempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baseurl-replacer-test-"));
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

  it("normalizes and validates new base URLs", () => {
    expect(normalizeBaseUrl("http://192.168.1.100:3000/")).toBe("http://192.168.1.100:3000");
    expect(normalizeBaseUrl("https://media.mysite.com")).toBe("https://media.mysite.com");
    expect(() => normalizeBaseUrl("ftp://test.com")).toThrow();
    expect(() => normalizeBaseUrl("")).toThrow();
  });

  it("replaces prefix in line correctly", () => {
    const res1 = replaceBaseUrlInLine(
      "http://192.168.1.5:3000/api/strm/play/cs_1/f1?name=test.mp4",
      "https://media.domain.com:8443",
    );
    expect(res1.changed).toBe(true);
    expect(res1.replaced.trim()).toBe(
      "https://media.domain.com:8443/api/strm/play/cs_1/f1?name=test.mp4",
    );

    const res2 = replaceBaseUrlInLine("https://media.domain.com/api/test", "https://media.domain.com");
    expect(res2.changed).toBe(false);
  });

  it("recursively batch replaces base URL across nested .strm files", async () => {
    const root = makeTempDir();
    const movieDir = path.join(root, "Movies", "Avatar (2009)");
    const tvDir = path.join(root, "TV", "Breaking Bad (2008)", "Season 01");
    fs.mkdirSync(movieDir, { recursive: true });
    fs.mkdirSync(tvDir, { recursive: true });

    const f1 = path.join(movieDir, "Avatar (2009).strm");
    const f2 = path.join(tvDir, "S01E01.strm");
    const f3 = path.join(tvDir, "S01E02.strm");
    const txtFile = path.join(tvDir, "info.nfo");

    fs.writeFileSync(f1, "http://10.0.0.1:3000/api/strm/play/cs_1/f1\n");
    fs.writeFileSync(f2, "http://10.0.0.1:3000/api/strm/play/cs_1/f2\n");
    fs.writeFileSync(f3, "http://10.0.0.1:3000/api/strm/play/cs_1/f3\n");
    fs.writeFileSync(txtFile, "Some metadata not to be touched\n");

    const result = await replaceBaseUrlInFiles(root, "https://nas.myhome.net");

    expect(result.total).toBe(3);
    expect(result.updated).toBe(3);
    expect(result.errors).toHaveLength(0);

    const content1 = fs.readFileSync(f1, "utf8");
    expect(content1.trim()).toBe("https://nas.myhome.net/api/strm/play/cs_1/f1");

    const contentTxt = fs.readFileSync(txtFile, "utf8");
    expect(contentTxt).toBe("Some metadata not to be touched\n");
  });
});
