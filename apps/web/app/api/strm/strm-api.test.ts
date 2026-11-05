import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { InMemoryWorkflowRepository } from "@media-track/workflow";
import {
  setWorkflowRepositoryForTest,
  resetRuntimeContainerForTests,
} from "../../../lib/workflow-runtime";
import { GET as getTasks, POST as createTask } from "./tasks/route";
import {
  GET as getSingleTask,
  PUT as updateTask,
  DELETE as deleteTask,
} from "./tasks/[id]/route";
import { POST as replaceBaseUrl } from "./replace-base-url/route";
import { GET as playStream, HEAD as playHead } from "./play/[taskId]/[fileId]/route";

describe("STRM API Routes", () => {
  let repo: InMemoryWorkflowRepository;
  const tempDirs: string[] = [];

  const makeTempDir = () => {
    const dir = path.join(process.cwd(), "data", `strm-api-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);
    return dir;
  };

  beforeEach(() => {
    resetRuntimeContainerForTests();
    repo = new InMemoryWorkflowRepository();
    setWorkflowRepositoryForTest(repo as any);
  });

  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  });

  it("POST & GET /api/strm/tasks 创建并列出 STRM 任务", async () => {
    const tempDir = makeTempDir();
    const createReq = new NextRequest("http://localhost:3000/api/strm/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "115影视同步",
        storageId: "cs_115",
        remoteFolderId: "root_115",
        remotePath: "/Media/Movies",
        localOutputDir: path.relative(process.cwd(), tempDir).replace(/\\/g, "/"),
        scanIntervalMinutes: 120,
      }),
    });

    const createRes = await createTask(createReq);
    expect(createRes.status).toBe(201);
    const createdTask = await createRes.json();
    expect(createdTask.name).toBe("115影视同步");
    expect(createdTask.storageId).toBe("cs_115");

    const getReq = new NextRequest("http://localhost:3000/api/strm/tasks");
    const getRes = await getTasks(getReq);
    expect(getRes.status).toBe(200);
    const list = await getRes.json();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(createdTask.id);
  });

  it("POST /api/strm/replace-base-url 快速重写目录内所有 STRM 播放前缀", async () => {
    const tempDir = makeTempDir();
    const strmFile1 = path.join(tempDir, "movie1.strm");
    const strmFile2 = path.join(tempDir, "sub", "movie2.strm");
    fs.mkdirSync(path.join(tempDir, "sub"), { recursive: true });

    fs.writeFileSync(strmFile1, "http://192.168.1.50:3000/api/strm/play/115/f1", "utf8");
    fs.writeFileSync(strmFile2, "http://192.168.1.50:3000/api/strm/play/115/f2", "utf8");

    const req = new NextRequest("http://localhost:3000/api/strm/replace-base-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        directoryPath: path.relative(process.cwd(), tempDir).replace(/\\/g, "/"),
        newBaseUrl: "https://mediary.example.com",
      }),
    });

    const res = await replaceBaseUrl(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.updated).toBe(2);

    expect(fs.readFileSync(strmFile1, "utf8").trim()).toBe(
      "https://mediary.example.com/api/strm/play/115/f1",
    );
    expect(fs.readFileSync(strmFile2, "utf8").trim()).toBe(
      "https://mediary.example.com/api/strm/play/115/f2",
    );
  });

  it("POST /api/strm/replace-base-url 自动支持使用全部任务中的路径（无需传入 directoryPath）", async () => {
    const dir1 = makeTempDir();
    const dir2 = makeTempDir();

    // 在 repo 中创建两个不同的 STRM 任务
    await repo.createStrmTask({
      accountId: "acct_default",
      name: "任务1",
      storageId: "cs_1",
      remoteFolderId: "rf_1",
      remotePath: "/Movies",
      localOutputDir: path.relative(process.cwd(), dir1).replace(/\\/g, "/"),
    });
    await repo.createStrmTask({
      accountId: "acct_default",
      name: "任务2",
      storageId: "cs_2",
      remoteFolderId: "rf_2",
      remotePath: "/Anime",
      localOutputDir: path.relative(process.cwd(), dir2).replace(/\\/g, "/"),
    });

    const file1 = path.join(dir1, "t1.strm");
    const file2 = path.join(dir2, "t2.strm");
    fs.writeFileSync(file1, "http://old-nas:3000/api/strm/play/1/f1\n", "utf8");
    fs.writeFileSync(file2, "http://old-nas:3000/api/strm/play/2/f2\n", "utf8");

    // 不传递 directoryPath，完全由后端自动检测所有任务目录
    const req = new NextRequest("http://localhost:3000/api/strm/replace-base-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        newBaseUrl: "https://auto-tasks.example.com",
      }),
    });

    const res = await replaceBaseUrl(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.updated).toBe(2);
    expect(data.directories).toEqual(expect.arrayContaining([dir1, dir2]));

    expect(fs.readFileSync(file1, "utf8").trim()).toBe("https://auto-tasks.example.com/api/strm/play/1/f1");
    expect(fs.readFileSync(file2, "utf8").trim()).toBe("https://auto-tasks.example.com/api/strm/play/2/f2");
  });

  it("GET /api/strm/play/{taskId}/{fileId} 返回 302 Found 与反缓存标头，支持 SingleFlight 缓存", async () => {
    await repo.upsertConnectedStorage({
      id: "cs_mock_drive",
      accountId: "acct_default",
      provider: "mock_pan",
      providerUid: "uid_mock",
      payload: { cookie: "test" },
      createdAt: new Date().toISOString(),
    });

    const task = await repo.createStrmTask({
      id: "task_play_302",
      accountId: "acct_default",
      name: "302 重定向测试任务",
      storageId: "cs_mock_drive",
      remoteFolderId: "root",
      remotePath: "/Media",
      localOutputDir: "/tmp/media",
      deliveryMode: "redirect",
    });

    const req = new NextRequest(`http://localhost:3000/api/strm/play/${task.id}/video_100`);
    const context = {
      params: Promise.resolve({ taskId: task.id, fileId: "video_100" }),
    };

    const res = await playStream(req, context);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("https://mock-cdn.cloudpan.com/download/cs_mock_drive/video_100");
    expect(res.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate, max-age=0");
    expect(res.headers.get("Pragma")).toBe("no-cache");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Expires")).toBe("0");

    // 再次请求直接命中 Link Cache
    const cached = await repo.getStrmLinkCache("cs_mock_drive:video_100");
    expect(cached).not.toBeNull();
    expect(cached?.downloadUrl).toContain("video_100");
  });

  it("GET /api/strm/play/{taskId}/{fileId} 支持状态机保护：任务不存在 404，任务暂停 403", async () => {
    // 1. 任务不存在时返回 404
    const notFoundReq = new NextRequest("http://localhost:3000/api/strm/play/task_not_exist/video_1");
    const res404 = await playStream(notFoundReq, {
      params: Promise.resolve({ taskId: "task_not_exist", fileId: "video_1" }),
    });
    expect(res404.status).toBe(404);

    // 2. 任务处于暂停或非 active 状态时熔断返回 403
    await repo.upsertConnectedStorage({
      id: "cs_active_drive",
      accountId: "acct_default",
      provider: "mock_pan",
      providerUid: "uid_active",
      payload: { cookie: "test" },
      createdAt: new Date().toISOString(),
    });

    const pausedTask = await repo.createStrmTask({
      id: "task_paused",
      accountId: "acct_default",
      name: "已暂停任务",
      storageId: "cs_active_drive",
      remoteFolderId: "root",
      remotePath: "/Paused",
      localOutputDir: "/tmp/paused",
      deliveryMode: "redirect",
      isActive: false,
    });

    const pausedReq = new NextRequest(`http://localhost:3000/api/strm/play/${pausedTask.id}/video_2`);
    const res403 = await playStream(pausedReq, {
      params: Promise.resolve({ taskId: pausedTask.id, fileId: "video_2" }),
    });
    expect(res403.status).toBe(403);
  });

  it("GET, PUT, DELETE /api/strm/tasks/[id] 支持任务详情、配置修改与安全删除", async () => {
    const tempDir = makeTempDir();
    const createReq = new NextRequest("http://localhost:3000/api/strm/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "原任务",
        storageId: "cs_115",
        remoteFolderId: "f_1",
        remotePath: "/Movies",
        localOutputDir: path.relative(process.cwd(), tempDir).replace(/\\/g, "/"),
      }),
    });
    const createRes = await createTask(createReq);
    expect(createRes.status).toBe(201);
    const task = await createRes.json();

    const context = { params: Promise.resolve({ id: task.id }) };

    // 1. GET /api/strm/tasks/[id]
    const getRes = await getSingleTask(
      new NextRequest(`http://localhost:3000/api/strm/tasks/${task.id}`),
      context,
    );
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.name).toBe("原任务");

    // 2. PUT /api/strm/tasks/[id] (修改配置)
    const putReq = new NextRequest(`http://localhost:3000/api/strm/tasks/${task.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "修改后的任务名称",
        scanIntervalMinutes: 720,
        isActive: false,
        deliveryMode: "proxy",
      }),
    });
    const putRes = await updateTask(putReq, context);
    expect(putRes.status).toBe(200);
    const updated = await putRes.json();
    expect(updated.name).toBe("修改后的任务名称");
    expect(updated.scanIntervalMinutes).toBe(720);
    expect(updated.isActive).toBe(false);
    expect(updated.deliveryMode).toBe("proxy");

    // 重新获取验证持久化生效
    const reGetRes = await getSingleTask(
      new NextRequest(`http://localhost:3000/api/strm/tasks/${task.id}`),
      context,
    );
    expect(reGetRes.status).toBe(200);
    const reFetched = await reGetRes.json();
    expect(reFetched.deliveryMode).toBe("proxy");

    // 3. DELETE /api/strm/tasks/[id] 并清理本地 .strm
    const dummyStrm = path.join(tempDir, "test.strm");
    fs.writeFileSync(dummyStrm, "http://localhost/dummy", "utf8");
    expect(fs.existsSync(dummyStrm)).toBe(true);

    const delReq = new NextRequest(
      `http://localhost:3000/api/strm/tasks/${task.id}?purgeFiles=true`,
      { method: "DELETE" },
    );
    const delRes = await deleteTask(delReq, context);
    expect(delRes.status).toBe(200);
    const delData = await delRes.json();
    expect(delData.ok).toBe(true);
    expect(delData.purgedStrmFiles).toBe(1);
    expect(fs.existsSync(dummyStrm)).toBe(false);

    // 验证数据库中已删除
    const checkDeleted = await repo.getStrmTask(task.id, "acc_default");
    expect(checkDeleted).toBeNull();
  });

  it("GET /api/strm/play/{taskId}/{fileId} 依据任务字典 deliveryMode=proxy 输出 HTTP 206 Range 分片转发", async () => {
    await repo.upsertConnectedStorage({
      id: "cs_quark",
      accountId: "acct_default",
      provider: "quark",
      providerUid: "uid_quark",
      payload: { cookie: "test" },
      createdAt: new Date().toISOString(),
    });

    const proxyTask = await repo.createStrmTask({
      id: "task_proxy_test",
      accountId: "acct_default",
      name: "Quark Auto Proxy Task",
      storageId: "cs_quark",
      remoteFolderId: "f_auto",
      remotePath: "/Auto",
      localOutputDir: "/tmp/auto",
      deliveryMode: "proxy",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const isHead = init?.method === "HEAD";
      const headers = new Headers();
      headers.set("Content-Range", "bytes 0-1024/10485760");
      headers.set("Content-Length", "1025");
      headers.set("Content-Type", "video/mp4");
      headers.set("Accept-Ranges", "bytes");

      if (isHead) {
        return new Response(null, { status: 206, headers });
      }

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 1, 2, 3]));
          controller.close();
        },
      });
      return new Response(stream, { status: 206, headers });
    });

    try {
      // 1. GET 请求带 Range（URL 纯净无 mode=proxy 传参）
      const req = new NextRequest(`http://localhost:3000/api/strm/play/${proxyTask.id}/video_proxy`, {
        headers: {
          Range: "bytes=0-1024",
          "User-Agent": "Infuse/7.0",
        },
      });
      const context = {
        params: Promise.resolve({ taskId: proxyTask.id, fileId: "video_proxy" }),
      };

      const res = await playStream(req, context);
      expect(res.status).toBe(206);
      expect(res.headers.get("Accept-Ranges")).toBe("bytes");
      expect(res.headers.get("Content-Range")).toBe("bytes 0-1024/10485760");
      expect(res.headers.get("Content-Type")).toBe("video/mp4");
      expect(res.headers.get("Cache-Control")).toContain("no-cache");

      // 验证 upstream fetch 调用传参
      expect(fetchSpy).toHaveBeenCalled();
      const [calledUrl, calledInit] = fetchSpy.mock.calls[0]!;
      expect(String(calledUrl)).toContain("mock-cdn.cloudpan.com/download/cs_quark/video_proxy");
      expect((calledInit?.headers as Record<string, string>)?.["Range"]).toBe("bytes=0-1024");

      // 2. HEAD 请求测试
      const headReq = new NextRequest(`http://localhost:3000/api/strm/play/${proxyTask.id}/video_proxy`, {
        method: "HEAD",
        headers: { "User-Agent": "Plex/1.0" },
      });
      const headRes = await playHead(headReq, context);
      expect(headRes.status).toBe(206);
      expect(headRes.headers.get("Content-Length")).toBe("1025");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("pan115 驱动自适应启用 proxy，重写 Content-Disposition 为 inline 并推导 video/x-matroska", async () => {
    await repo.upsertConnectedStorage({
      id: "cs_115_real",
      accountId: "acct_default",
      provider: "pan115",
      providerUid: "uid_115",
      payload: { cookie: "test" },
      createdAt: new Date().toISOString(),
    });

    const task115 = await repo.createStrmTask({
      id: "task_115_test",
      accountId: "acct_default",
      name: "115 任务",
      storageId: "cs_115_real",
      remoteFolderId: "f_115",
      remotePath: "/Anime",
      localOutputDir: "/tmp/115",
      deliveryMode: "redirect", // 任务即使设置 redirect，驱动是 pan115 时自动升级为 proxy
    });

    await repo.setStrmLinkCache({
      cacheKey: "cs_115_real:video_dragon",
      downloadUrl: "https://mock-115-cdn.net/dragon.mkv",
      deliveryMode: "proxy",
      headersJson: null,
      expiresAt: Math.floor(Date.now() / 1000) + 7200,
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const headers = new Headers();
      headers.set("Content-Range", "bytes 0-1000/5000000");
      headers.set("Content-Length", "1001");
      headers.set("Content-Type", "application/octet-stream"); // 115 上游原样返回的 octet-stream
      headers.set("Content-Disposition", 'attachment; filename="dragonball.mkv"'); // 115 上游原样返回的 attachment
      headers.set("Accept-Ranges", "bytes");

      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1, 2, 3]));
          c.close();
        },
      });
      return new Response(stream, { status: 206, headers });
    });

    try {
      const req = new NextRequest(
        `http://localhost:3000/api/strm/play/${task115.id}/video_dragon?name=%E9%BE%99%E7%8F%A0%E8%B6%85.mkv`,
        {
          headers: {
            Range: "bytes=0-1000",
            "User-Agent": "Mozilla/5.0 Chrome/126.0.0.0",
          },
        },
      );
      const context = {
        params: Promise.resolve({ taskId: task115.id, fileId: "video_dragon" }),
      };

      const res = await playStream(req, context);
      expect(res.status).toBe(206);
      // 必须将 application/octet-stream 纠正为 video/x-matroska
      expect(res.headers.get("content-type")).toBe("video/x-matroska");
      // 必须将 attachment 纠正为 inline，防止浏览器或播放器弹出下载对话框
      expect(res.headers.get("content-disposition")).toContain("inline;");
      expect(res.headers.get("content-disposition")).toContain("filename*=");
      expect(res.headers.get("accept-ranges")).toBe("bytes");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
