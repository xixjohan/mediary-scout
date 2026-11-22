import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { PERMISSION_CATALOG, BUILTIN_ROLES, ApiKeyPermissionPreset } from "@media-track/shared";
import { MCP_REGISTERED_TOOLS, TOOL_TO_PERMISSION_MAP, POST } from "./route";

// Mock dependencies
vi.mock("../../../platform/next-context/auth-chain", () => ({
  resolveSecurityContext: vi.fn(),
}));

vi.mock("./executor", () => ({
  executeGetMediaDetail: vi.fn().mockResolvedValue({ ok: true, tmdbId: 100 }),
  executeGetTrendingMedia: vi.fn().mockResolvedValue({ ok: true, results: [] }),
  executeSearchResources: vi.fn().mockResolvedValue({ ok: true, candidates: [] }),
  executeScrapeResourceMetadata: vi.fn().mockResolvedValue({ ok: true, parsed: { title: "Test" } }),
  executeListSubscriptions: vi.fn().mockResolvedValue({ ok: true, items: [] }),
  executeGetSubscriptionDetail: vi.fn().mockResolvedValue({ ok: true, tmdbId: 100 }),
  executeUpdateSubscription: vi.fn().mockResolvedValue({ ok: true, tmdbId: 100 }),
  executeDeleteSubscription: vi.fn().mockResolvedValue({ ok: true, tmdbId: 100 }),
  executeGetStorageDrives: vi.fn().mockResolvedValue({ ok: true, drives: [] }),
  executeCheckDriveQuota: vi.fn().mockResolvedValue({ ok: true, quota: { available: true } }),
  executeSearchDriveFiles: vi.fn().mockResolvedValue({ ok: true, matches: [] }),
  executeGetDriveDownloadUrl: vi.fn().mockResolvedValue({ ok: true, playStreamUrl: "/api/strm/play/1/1" }),
  executeListStrmTasks: vi.fn().mockResolvedValue({ ok: true, tasks: [] }),
  executeCreateStrmTask: vi.fn().mockResolvedValue({ ok: true, task: { id: "strm_1" } }),
  executeTriggerStrmSync: vi.fn().mockResolvedValue({ ok: true, taskId: "strm_1" }),
  executeListMediaServers: vi.fn().mockResolvedValue({ ok: true, servers: [] }),
  executeSyncMediaServerLibrary: vi.fn().mockResolvedValue({ ok: true, message: "ok" }),
  executeTestMediaServerConnection: vi.fn().mockResolvedValue({ ok: true, status: { ok: true } }),
  executeListExtensions: vi.fn().mockResolvedValue({ ok: true, extensions: [] }),
  executeToggleExtension: vi.fn().mockResolvedValue({ ok: true, enabled: true }),
}));

vi.mock("./drive-media-executor", () => ({
  executeScanDriveMedia: vi.fn().mockResolvedValue({ ok: true, candidates: [] }),
  executeAdoptDriveMedia: vi.fn().mockResolvedValue({ ok: true, adopted: true, tmdbId: 100 }),
  executePlanOrganizeMedia: vi.fn().mockResolvedValue({ ok: true, planKind: "deterministic", moves: [] }),
  executeExecuteOrganizeMedia: vi.fn().mockResolvedValue({ ok: true, status: "organized" }),
}));

vi.mock("../../../features/assistant/application/chat-agent-service", () => ({
  executeSearchMedia: vi.fn().mockResolvedValue({ reply: "search ok" }),
  executeQueryStatus: vi.fn().mockResolvedValue({ reply: "status ok" }),
  executeQueryLibrary: vi.fn().mockResolvedValue({ reply: "library ok" }),
}));

vi.mock("../../../features/assistant/core/chat-discover", () => ({
  executeDiscoverMedia: vi.fn().mockResolvedValue({ reply: "discover ok" }),
}));

vi.mock("../../../lib/workflow-runtime", () => ({
  getAccountDriveFileManager: vi.fn().mockResolvedValue({
    listDirectory: vi.fn().mockResolvedValue({ items: [] }),
  }),
}));

vi.mock("../../../features/acquisition/application/manual-subscription-search-service", () => ({
  triggerManualSubscriptionSearch: vi.fn().mockResolvedValue({ status: "queued" }),
}));

import { resolveSecurityContext } from "../../../platform/next-context/auth-chain";

function createMockRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("MCP Full Lifecycle Matrix & RBAC Projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("1. 工具注册表与权限元数据一致性", () => {
    it("registered tools count should be at least 25 (includes 25 lifecycle tools + utility tools)", () => {
      expect(MCP_REGISTERED_TOOLS.length).toBeGreaterThanOrEqual(25);
    });

    it("every registered tool has a valid permission mapping", () => {
      const allCatalogLeaves = new Set(PERMISSION_CATALOG.flatMap((m) => m.leaves.map((l) => l.id)));
      for (const tool of MCP_REGISTERED_TOOLS) {
        const perm = TOOL_TO_PERMISSION_MAP[tool.name];
        expect(perm).toBeDefined();
        expect(allCatalogLeaves.has(perm!)).toBe(true);
      }
    });

    it("all 8 core lifecycle areas are covered by registered tools", () => {
      const toolNames = new Set(MCP_REGISTERED_TOOLS.map((t) => t.name));
      // 1. 影视搜索
      expect(toolNames.has("searchMedia")).toBe(true);
      expect(toolNames.has("discoverMedia")).toBe(true);
      expect(toolNames.has("getMediaDetail")).toBe(true);
      expect(toolNames.has("getTrendingMedia")).toBe(true);

      // 2. 资源查询与刮削
      expect(toolNames.has("searchResources")).toBe(true);
      expect(toolNames.has("scrapeResourceMetadata")).toBe(true);

      // 3. 订阅管理
      expect(toolNames.has("listSubscriptions")).toBe(true);
      expect(toolNames.has("getSubscriptionDetail")).toBe(true);
      expect(toolNames.has("subscribeMedia")).toBe(true);
      expect(toolNames.has("updateSubscription")).toBe(true);
      expect(toolNames.has("deleteSubscription")).toBe(true);

      // 4. 网盘管理与存量整理
      expect(toolNames.has("getStorageDrives")).toBe(true);
      expect(toolNames.has("checkDriveQuota")).toBe(true);
      expect(toolNames.has("listStorageFiles")).toBe(true);
      expect(toolNames.has("searchDriveFiles")).toBe(true);
      expect(toolNames.has("submitOfflineTask")).toBe(true);
      expect(toolNames.has("getDriveDownloadUrl")).toBe(true);
      expect(toolNames.has("scanDriveMedia")).toBe(true);
      expect(toolNames.has("adoptDriveMedia")).toBe(true);
      expect(toolNames.has("planOrganizeMedia")).toBe(true);
      expect(toolNames.has("executeOrganizeMedia")).toBe(true);
      expect(toolNames.has("cleanStagingDirectories")).toBe(true);
      expect(toolNames.has("dedupeSeasonVersions")).toBe(true);

      // 5. STRM 管理
      expect(toolNames.has("listStrmTasks")).toBe(true);
      expect(toolNames.has("createStrmTask")).toBe(true);
      expect(toolNames.has("triggerStrmSync")).toBe(true);

      // 6. 第三方媒体库
      expect(toolNames.has("listMediaServers")).toBe(true);
      expect(toolNames.has("syncMediaServerLibrary")).toBe(true);
      expect(toolNames.has("testMediaServerConnection")).toBe(true);

      // 7. 动态扩展与插件
      expect(toolNames.has("listExtensions")).toBe(true);
      expect(toolNames.has("toggleExtension")).toBe(true);

      // 8. 辅助状态
      expect(toolNames.has("queryStatus")).toBe(true);
      expect(toolNames.has("queryLibrary")).toBe(true);
      expect(toolNames.has("triggerAcquisition")).toBe(true);
      expect(toolNames.has("getSystemHealth")).toBe(true);
    });
  });

  describe("2. 按角色动态投影裁剪 (tools/list Dynamic Projection)", () => {
    it("Owner (*): projects all registered tools without omission", () => {
      const ownerPerms = ["*"];
      const projected = ApiKeyPermissionPreset.projectMcpTools(
        ownerPerms,
        MCP_REGISTERED_TOOLS,
        TOOL_TO_PERMISSION_MAP
      );
      expect(projected.length).toBe(MCP_REGISTERED_TOOLS.length);
    });

    it("Admin: projects full tools including STRM, media servers and extensions", () => {
      const adminPerms = BUILTIN_ROLES.role_admin.permissions;
      const projected = ApiKeyPermissionPreset.projectMcpTools(
        adminPerms,
        MCP_REGISTERED_TOOLS,
        TOOL_TO_PERMISSION_MAP
      );
      const names = new Set(projected.map((t) => t.name));
      expect(names.has("createStrmTask")).toBe(true);
      expect(names.has("listMediaServers")).toBe(true);
      expect(names.has("toggleExtension")).toBe(true);
      expect(names.has("checkDriveQuota")).toBe(true);
    });

    it("Member: projects only search, subscription, cloud browsing; hides STRM, media servers, and extensions", () => {
      const memberPerms = BUILTIN_ROLES.role_member.permissions;
      const projected = ApiKeyPermissionPreset.projectMcpTools(
        memberPerms,
        MCP_REGISTERED_TOOLS,
        TOOL_TO_PERMISSION_MAP
      );
      const names = new Set(projected.map((t) => t.name));

      // Member 有权可见的工具
      expect(names.has("searchMedia")).toBe(true);
      expect(names.has("discoverMedia")).toBe(true);
      expect(names.has("getMediaDetail")).toBe(true);
      expect(names.has("getTrendingMedia")).toBe(true);
      expect(names.has("searchResources")).toBe(true);
      expect(names.has("scrapeResourceMetadata")).toBe(true);
      expect(names.has("listSubscriptions")).toBe(true);
      expect(names.has("getSubscriptionDetail")).toBe(true);
      expect(names.has("subscribeMedia")).toBe(true);
      expect(names.has("updateSubscription")).toBe(true);
      expect(names.has("deleteSubscription")).toBe(true);
      expect(names.has("getStorageDrives")).toBe(true);
      expect(names.has("checkDriveQuota")).toBe(true);
      expect(names.has("listStorageFiles")).toBe(true);
      expect(names.has("searchDriveFiles")).toBe(true);
      expect(names.has("submitOfflineTask")).toBe(true);
      expect(names.has("getDriveDownloadUrl")).toBe(true);
      expect(names.has("scanDriveMedia")).toBe(true);
      expect(names.has("adoptDriveMedia")).toBe(true);
      expect(names.has("queryStatus")).toBe(true);
      expect(names.has("queryLibrary")).toBe(true);

      // Member 严禁可见的管理级工具（彻底杜绝 Token 浪费与越权幻觉）
      expect(names.has("planOrganizeMedia")).toBe(false);
      expect(names.has("executeOrganizeMedia")).toBe(false);
      expect(names.has("createStrmTask")).toBe(false);
      expect(names.has("listStrmTasks")).toBe(false);
      expect(names.has("triggerStrmSync")).toBe(false);
      expect(names.has("listMediaServers")).toBe(false);
      expect(names.has("syncMediaServerLibrary")).toBe(false);
      expect(names.has("testMediaServerConnection")).toBe(false);
      expect(names.has("listExtensions")).toBe(false);
      expect(names.has("toggleExtension")).toBe(false);
      expect(names.has("triggerAcquisition")).toBe(false);
      expect(names.has("getSystemHealth")).toBe(false);
    });

    it("Guest: projects only read-only search and health check tools", () => {
      const guestPerms = BUILTIN_ROLES.role_guest.permissions;
      const projected = ApiKeyPermissionPreset.projectMcpTools(
        guestPerms,
        MCP_REGISTERED_TOOLS,
        TOOL_TO_PERMISSION_MAP
      );
      const names = new Set(projected.map((t) => t.name));
      expect(names.has("searchMedia")).toBe(true);
      expect(names.has("getSystemHealth")).toBe(true);
      expect(names.has("submitOfflineTask")).toBe(false);
      expect(names.has("createStrmTask")).toBe(false);
      expect(names.has("toggleExtension")).toBe(false);
    });
  });

  describe("3. 运行时调用卡口与权限拦截 (tools/call Execution & Guard)", () => {
    it("returns 401 when request has no valid security context", async () => {
      vi.mocked(resolveSecurityContext).mockResolvedValue(null);
      const req = createMockRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const res = await POST(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe(-32001);
    });

    it("blocks request when API Key has allowMcp: false", async () => {
      vi.mocked(resolveSecurityContext).mockResolvedValue({
        accountId: "acc_1",
        isMaster: false,
        roleId: "role_member",
        permissions: new Set(["*"]),
        apiKeyId: "key_1",
        allowMcp: false,
      });
      const req = createMockRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const res = await POST(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe(-32003);
    });

    it("blocks unauthorized tool execution with -32003 Forbidden", async () => {
      // Member tries to call createStrmTask
      vi.mocked(resolveSecurityContext).mockResolvedValue({
        accountId: "acc_member",
        isMaster: false,
        roleId: "role_member",
        permissions: new Set(BUILTIN_ROLES.role_member.permissions),
      });

      const req = createMockRequest({
        jsonrpc: "2.0",
        id: "call-1",
        method: "tools/call",
        params: {
          name: "createStrmTask",
          arguments: {
            name: "test",
            storageId: "drive_1",
            remoteFolderId: "f_1",
            localOutputDir: "/strm",
          },
        },
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe(-32003);
      expect(json.error.message).toContain("Forbidden");
      expect(json.error.message).toContain("strm:manage");
    });

    it("executes permitted tool successfully for authorized role", async () => {
      vi.mocked(resolveSecurityContext).mockResolvedValue({
        accountId: "acc_admin",
        isMaster: false,
        roleId: "role_admin",
        permissions: new Set(BUILTIN_ROLES.role_admin.permissions),
      });

      const req = createMockRequest({
        jsonrpc: "2.0",
        id: "call-2",
        method: "tools/call",
        params: {
          name: "listStrmTasks",
          arguments: {},
        },
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error).toBeUndefined();
      expect(json.result).toBeDefined();
      expect(json.result.content[0].type).toBe("text");
      const data = JSON.parse(json.result.content[0].text);
      expect(data.ok).toBe(true);
    });

    it("executes scanDriveMedia successfully for role with storage:adopt permission", async () => {
      vi.mocked(resolveSecurityContext).mockResolvedValue({
        accountId: "acc_member",
        isMaster: false,
        roleId: "role_member",
        permissions: new Set(BUILTIN_ROLES.role_member.permissions),
      });

      const req = createMockRequest({
        jsonrpc: "2.0",
        id: "scan-1",
        method: "tools/call",
        params: {
          name: "scanDriveMedia",
          arguments: { folderId: "f_root" },
        },
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error).toBeUndefined();
      const data = JSON.parse(json.result.content[0].text);
      expect(data.ok).toBe(true);
    });

    it("blocks organize tools when role lacks storage:organize permission", async () => {
      vi.mocked(resolveSecurityContext).mockResolvedValue({
        accountId: "acc_member",
        isMaster: false,
        roleId: "role_member",
        permissions: new Set(BUILTIN_ROLES.role_member.permissions),
      });

      const req = createMockRequest({
        jsonrpc: "2.0",
        id: "plan-1",
        method: "tools/call",
        params: {
          name: "planOrganizeMedia",
          arguments: { tmdbId: 100 },
        },
      });

      const res = await POST(req);
      const json = await res.json();
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe(-32003);
      expect(json.error.message).toContain("storage:organize");
    });

    it("returns -32601 when calling an unregistered tool", async () => {
      vi.mocked(resolveSecurityContext).mockResolvedValue({
        accountId: "acc_admin",
        isMaster: true,
        roleId: "role_owner",
        permissions: new Set(["*"]),
      });

      const req = createMockRequest({
        jsonrpc: "2.0",
        id: "call-3",
        method: "tools/call",
        params: {
          name: "nonExistentTool",
          arguments: {},
        },
      });

      const res = await POST(req);
      const json = await res.json();
      expect(json.error.code).toBe(-32601);
      expect(json.error.message).toContain("Tool not found");
    });

    it("handles initialize method compliant with MCP specification", async () => {
      vi.mocked(resolveSecurityContext).mockResolvedValue({
        accountId: "acc_1",
        isMaster: true,
        roleId: "role_owner",
        permissions: new Set(["*"]),
      });

      const req = createMockRequest({
        jsonrpc: "2.0",
        id: "init-1",
        method: "initialize",
      });

      const res = await POST(req);
      const json = await res.json();
      expect(json.result.protocolVersion).toBe("2024-11-05");
      expect(json.result.serverInfo.name).toBe("mediary-scout-mcp");
    });
  });
});
