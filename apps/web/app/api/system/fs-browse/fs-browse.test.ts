import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";

describe("System FS Browse API", () => {
  const tempDirs: string[] = [];

  const makeTempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-browse-test-"));
    tempDirs.push(dir);
    return dir;
  };

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

  it("GET /api/system/fs-browse 列出指定工作区目录的子文件夹", async () => {
    const cwd = process.cwd();
    const req = new NextRequest(`http://localhost:3000/api/system/fs-browse?path=${encodeURIComponent(cwd)}`);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.currentPath).toBe(path.resolve(cwd));
    expect(Array.isArray(data.directories)).toBe(true);
    // 应包含 apps, packages, docs
    const names = data.directories.map((d: any) => d.name);
    expect(names).toContain("apps");
    expect(names).toContain("packages");
    // 不应包含 .git, node_modules 等敏感目录
    expect(names).not.toContain(".git");
    expect(names).not.toContain("node_modules");
  });

  it("GET /api/system/fs-browse 安全拦截：试图越权访问非法路径返回 403", async () => {
    const req = new NextRequest("http://localhost:3000/api/system/fs-browse?path=Z:\\Totally\\Fake\\Path\\Escape");
    const res = await GET(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain("安全拦截");
  });

  it("POST /api/system/fs-browse 在允许的目录下新建子文件夹", async () => {
    const tempSub = path.join(process.cwd(), "run", `test-fs-dir-${Date.now()}`);
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
});
