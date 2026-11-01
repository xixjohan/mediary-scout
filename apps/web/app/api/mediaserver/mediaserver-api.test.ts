import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { InMemoryWorkflowRepository } from "@media-track/workflow";
import {
  setWorkflowRepositoryForTest,
  resetRuntimeContainerForTests,
} from "../../../lib/workflow-runtime";
import { setMediaServerCoordinatorForTest } from "../../../composition/runtime-container";
import { GET as getConfigs, POST as createConfig } from "./configs/route";
import { DELETE as deleteConfig } from "./configs/[id]/route";
import { GET as getLibraries } from "./configs/[id]/libraries/route";
import { POST as probeLibraries } from "./probe-libraries/route";
import { POST as testConnection } from "./test/route";
import { POST as triggerRefresh } from "./refresh/route";

describe("MediaServer API Routes", () => {
  let repo: InMemoryWorkflowRepository;

  beforeEach(() => {
    resetRuntimeContainerForTests();
    repo = new InMemoryWorkflowRepository();
    setWorkflowRepositoryForTest(repo as any);
  });

  afterEach(() => {
    resetRuntimeContainerForTests();
  });

  it("POST, GET, DELETE /api/mediaserver/configs 生命周期管理", async () => {
    // 1. 创建配置
    const createReq = new NextRequest("http://localhost:3000/api/mediaserver/configs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "家庭 Plex",
        serverType: "plex",
        hostUrl: "http://192.168.1.10:32400",
        apiToken: "plex_token_xyz",
        pathMappings: [{ id: "m1", localPath: "/data/strm", remotePath: "/media" }],
      }),
    });

    const createRes = await createConfig(createReq);
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.name).toBe("家庭 Plex");
    expect(created.hasToken).toBe(true);
    expect(created.apiTokenEncrypted).toBeUndefined(); // 安全脱敏

    // 2. 列出配置
    const getReq = new NextRequest("http://localhost:3000/api/mediaserver/configs");
    const getRes = await getConfigs(getReq);
    expect(getRes.status).toBe(200);
    const list = await getRes.json();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);

    // 3. 删除配置
    const delReq = new NextRequest(`http://localhost:3000/api/mediaserver/configs/${created.id}`, {
      method: "DELETE",
    });
    const delRes = await deleteConfig(delReq, { params: Promise.resolve({ id: created.id }) });
    expect(delRes.status).toBe(200);

    const listAfter = await repo.listMediaServerConfigs("acct_local_owner");
    expect(listAfter).toHaveLength(0);
  });

  it("POST /api/mediaserver/test 连通性测试", async () => {
    const mockCoordinator = {
      testConnection: vi.fn().mockResolvedValue({
        ok: true,
        version: "1.32.0",
        serverName: "TestServer",
      }),
    };
    setMediaServerCoordinatorForTest(mockCoordinator as any);

    const req = new NextRequest("http://localhost:3000/api/mediaserver/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverType: "plex",
        hostUrl: "http://127.0.0.1:32400",
        apiToken: "test_token",
      }),
    });

    const res = await testConnection(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.version).toBe("1.32.0");
    expect(mockCoordinator.testConnection).toHaveBeenCalled();
  });

  it("POST /api/mediaserver/probe-libraries 实时探测远端媒体库", async () => {
    const mockCoordinator = {
      probeLibraries: vi.fn().mockResolvedValue([
        { id: "1", name: "电影", type: "movie", locations: ["/media/movies"] },
        { id: "2", name: "剧集", type: "show", locations: ["/media/tv"] },
      ]),
    };
    setMediaServerCoordinatorForTest(mockCoordinator as any);

    const req = new NextRequest("http://localhost:3000/api/mediaserver/probe-libraries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverType: "plex",
        hostUrl: "http://127.0.0.1:32400",
        apiToken: "test_token",
      }),
    });

    const res = await probeLibraries(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.libraries).toHaveLength(2);
    expect(data.libraries[0].name).toBe("电影");
  });

  it("GET /api/mediaserver/configs/[id]/libraries 获取已保存配置的媒体库", async () => {
    const mockCoordinator = {
      listLibraries: vi.fn().mockResolvedValue([
        { id: "10", name: "动漫", type: "show", locations: ["/media/anime"] },
      ]),
    };
    setMediaServerCoordinatorForTest(mockCoordinator as any);

    const req = new NextRequest("http://localhost:3000/api/mediaserver/configs/cfg_1/libraries");
    const res = await getLibraries(req, { params: Promise.resolve({ id: "cfg_1" }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.libraries[0].name).toBe("动漫");
  });

  it("POST /api/mediaserver/refresh 手动触发刷新", async () => {
    const mockCoordinator = {
      manualRefresh: vi.fn().mockResolvedValue({
        ok: true,
        refreshedCount: 1,
        sectionsRefreshed: ["电影"],
      }),
    };
    setMediaServerCoordinatorForTest(mockCoordinator as any);

    const req = new NextRequest("http://localhost:3000/api/mediaserver/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        configId: "cfg_123",
        targetPath: "/data/strm/movies/Avatar",
      }),
    });

    const res = await triggerRefresh(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.refreshedCount).toBe(1);
    expect(mockCoordinator.manualRefresh).toHaveBeenCalledWith(
      "cfg_123",
      expect.any(String),
      "/data/strm/movies/Avatar",
    );
  });
});
