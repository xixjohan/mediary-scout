import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { GET as playStream } from "./play/[storageId]/[fileId]/route";

describe("STRM API Routes", () => {
  let repo: InMemoryWorkflowRepository;
  const tempDirs: string[] = [];

  const makeTempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strm-api-test-"));
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
        localOutputDir: tempDir,
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
        directoryPath: tempDir,
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

  it("GET /api/strm/play/{storageId}/{fileId} 返回 302 Found 与反缓存标头，支持 SingleFlight 缓存", async () => {
    const req = new NextRequest("http://localhost:3000/api/strm/play/cs_115/video_100");
    const context = {
      params: Promise.resolve({ storageId: "cs_115", fileId: "video_100" }),
    };

    const res = await playStream(req, context);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("https://mock-cdn.cloudpan.com/download/cs_115/video_100");
    expect(res.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate, max-age=0");
    expect(res.headers.get("Pragma")).toBe("no-cache");

    // 再次请求直接命中 Link Cache
    const cached = await repo.getStrmLinkCache("cs_115:video_100");
    expect(cached).not.toBeNull();
    expect(cached?.downloadUrl).toContain("video_100");
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
        localOutputDir: tempDir,
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
      }),
    });
    const putRes = await updateTask(putReq, context);
    expect(putRes.status).toBe(200);
    const updated = await putRes.json();
    expect(updated.name).toBe("修改后的任务名称");
    expect(updated.scanIntervalMinutes).toBe(720);
    expect(updated.isActive).toBe(false);

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
});
