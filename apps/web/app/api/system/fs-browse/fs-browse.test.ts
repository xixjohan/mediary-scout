import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { resolveDataRoot, resolveStrmOutputPath } from "@media-track/workflow";
import { GET, POST } from "./route";

describe("System FS Browse API", () => {
  const tempDirs: string[] = [];

  const makeTempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browse-test-"));
    tempDirs.push(dir);
    return dir;
  };

  const programData = resolveDataRoot();
  const ensureOutput = (outputPath: string) => POST(new NextRequest("http://localhost:3000/api/system/fs-browse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "ensure-output", outputPath }),
  }));

  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  });

  it("GET /api/system/fs-browse 未指定 path 时返回可用根驱动器/目录", async () => {
    const req = new NextRequest("http://localhost:3000/api/system/fs-browse");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.isRoot).toBe(true);
    expect(Array.isArray(data.directories)).toBe(true);
    expect(data.directories.length).toBeGreaterThan(0);
  });

  it("GET /api/system/fs-browse 列出白名单目录的子文件夹并过滤敏感目录", async () => {
    // 不能依赖 process.cwd()：Linux 白名单只含 dataRoot 与挂载点，不含项目根，
    // 否则该用例在 CI 上必然 403（Windows 因盘符白名单而侥幸通过）。
    const base = path.join(programData, `fs-browse-list-${Date.now()}`);
    for (const name of ["apps", "packages", ".git", "node_modules"]) {
      fs.mkdirSync(path.join(base, name), { recursive: true });
    }
    tempDirs.push(base);

    const req = new NextRequest(
      `http://localhost:3000/api/system/fs-browse?path=${encodeURIComponent(base)}`,
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.currentPath).toBe(path.resolve(base));
    expect(Array.isArray(data.directories)).toBe(true);
    const names = data.directories.map((d: any) => d.name);
    expect(names).toContain("apps");
    expect(names).toContain("packages");
    // 不应包含 .git, node_modules 等敏感目录
    expect(names).not.toContain(".git");
    expect(names).not.toContain("node_modules");
  });

  it("GET /api/system/fs-browse 安全拦截：试图越权访问非法路径返回 403", async () => {
    const escapePath = process.platform === "win32" ? "Z:\\Totally\\Fake\\Path\\Escape" : "/var/log/outside-root-escape";
    const req = new NextRequest(`http://localhost:3000/api/system/fs-browse?path=${encodeURIComponent(escapePath)}`);
    const res = await GET(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain("安全拦截");
  });

  it("POST /api/system/fs-browse 在允许的目录下新建子文件夹", async () => {
    // 同样必须落在白名单内（dataRoot），而不是 process.cwd()。
    const tempSub = path.join(programData, `test-fs-dir-${Date.now()}`);
    fs.mkdirSync(tempSub, { recursive: true });
    tempDirs.push(tempSub);

    const req = new NextRequest("http://localhost:3000/api/system/fs-browse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parentPath: tempSub,
        folderName: "my_new_strm_folder",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    const created = path.join(tempSub, "my_new_strm_folder");
    expect(fs.existsSync(created)).toBe(true);
    expect(fs.statSync(created).isDirectory()).toBe(true);
  });

  it("GET 缺失 STRM 输出目录返回结构化 404 且不创建目录", async () => {
    const configPath = `data/fs-browse-missing-${Date.now()}`;
    const absolutePath = path.join(programData, path.basename(configPath));
    const res = await GET(new NextRequest(`http://localhost:3000/api/system/fs-browse?path=${encodeURIComponent(configPath)}`));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("DIRECTORY_NOT_FOUND");
    expect(fs.existsSync(absolutePath)).toBe(false);
  });

  it("ensure-output 首次创建目标并允许幂等重复调用", async () => {
    const configPath = `data/strm/ensure-${Date.now()}`;
    const absolutePath = resolveStrmOutputPath(configPath);
    tempDirs.push(absolutePath);
    const first = await ensureOutput(configPath);
    expect(first.status).toBe(200);
    expect((await first.json()).canWrite).toBe(true);
    const second = await ensureOutput(configPath);
    expect(second.status).toBe(200);
    expect(fs.statSync(absolutePath).isDirectory()).toBe(true);
  });

  it("ensure-output 拒绝根目录外路径，允许数据根目录下绝对路径", async () => {
    expect((await ensureOutput("data/../../outside")).status).toBe(400);
    const outsidePath = process.platform === "win32" ? "C:\\Temp\\Outside\\Escape" : "/var/log/outside-escape";
    expect((await ensureOutput(outsidePath)).status).toBe(400);

    const validAbs = path.join(programData, "strm", `abs-ensure-${Date.now()}`);
    tempDirs.push(validAbs);
    const validRes = await ensureOutput(validAbs);
    expect(validRes.status).toBe(200);
    expect((await validRes.json()).ok).toBe(true);
  });
});
