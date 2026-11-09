import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeBaseUrl,
  replaceBaseUrlInFiles,
  replaceBaseUrlInLine,
  replaceBaseUrlInDirectories,
  resolveEffectiveStrmBaseUrl,
} from "./base-url-replacer.js";
import { STRM_BASE_URL_SETTING_KEY } from "./strm-types.js";

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
  it("aggregates batch replacements across multiple directories", async () => {
    const root1 = makeTempDir();
    const root2 = makeTempDir();

    const f1 = path.join(root1, "movie1.strm");
    const f2 = path.join(root2, "movie2.strm");

    fs.writeFileSync(f1, "http://10.0.0.1:3000/api/strm/play/1/f1\n");
    fs.writeFileSync(f2, "http://10.0.0.1:3000/api/strm/play/2/f2\n");

    const result = await replaceBaseUrlInDirectories(
      [root1, root2, root1], // includes duplicate
      "https://media.newserver.com",
    );

    expect(result.total).toBe(2);
    expect(result.updated).toBe(2);
    expect(result.directories).toEqual([root1, root2]);
    expect(fs.readFileSync(f1, "utf8").trim()).toBe("https://media.newserver.com/api/strm/play/1/f1");
    expect(fs.readFileSync(f2, "utf8").trim()).toBe("https://media.newserver.com/api/strm/play/2/f2");
  });

  describe("resolveEffectiveStrmBaseUrl SSOT priority", () => {
    it("优先使用显式指定的 explicitUrl", async () => {
      const mockRepo = {
        getSetting: async () => "http://db-server:3000",
      };
      const res = await resolveEffectiveStrmBaseUrl(mockRepo, "https://explicit.domain.com:8443/");
      expect(res).toBe("https://explicit.domain.com:8443");
    });

    it("explicitUrl 为空时命中数据库设置 (STRM_BASE_URL_SETTING_KEY)", async () => {
      const mockRepo = {
        getSetting: async (k: string) => {
          if (k === STRM_BASE_URL_SETTING_KEY) return "http://192.168.1.100:3000/";
          return null;
        },
      };
      const res = await resolveEffectiveStrmBaseUrl(mockRepo);
      expect(res).toBe("http://192.168.1.100:3000");
    });

    it("数据库未配置时优先命中环境变量 APP_BASE_URL", async () => {
      const oldEnv = process.env.APP_BASE_URL;
      try {
        process.env.APP_BASE_URL = "http://192.168.1.88:3000/";
        const mockRepo = {
          getSetting: async () => null,
        };
        const res = await resolveEffectiveStrmBaseUrl(mockRepo);
        expect(res).toBe("http://192.168.1.88:3000");
      } finally {
        if (oldEnv === undefined) delete process.env.APP_BASE_URL;
        else process.env.APP_BASE_URL = oldEnv;
      }
    });

    it("全部未配置时安全降级到本地端口并输出控制台警告", async () => {
      const oldApp = process.env.APP_BASE_URL;
      const oldMed = process.env.MEDIARY_URL;
      try {
        delete process.env.APP_BASE_URL;
        delete process.env.MEDIARY_URL;
        const mockRepo = {
          getSetting: async () => null,
        };
        const res = await resolveEffectiveStrmBaseUrl(mockRepo);
        expect(res).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      } finally {
        if (oldApp !== undefined) process.env.APP_BASE_URL = oldApp;
        if (oldMed !== undefined) process.env.MEDIARY_URL = oldMed;
      }
    });
  });
});
