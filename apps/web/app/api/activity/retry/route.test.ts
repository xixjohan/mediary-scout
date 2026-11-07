import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("../../../../lib/demo-mode", () => ({ isDemoMode: vi.fn(() => false) }));

const retryFailedWorkflowRun = vi.fn();
const getWorkflowRunSnapshot = vi.fn();
const triggerManualSubscriptionSearch = vi.fn();

vi.mock("../../../../features/acquisition/application/manual-subscription-search-service", () => ({
  triggerManualSubscriptionSearch: (...args: unknown[]) => triggerManualSubscriptionSearch(...args),
}));

// S5.4：路由经 lib/auth-chain 登录链取账号，mock 需补上链路所需导出。
// 默认单用户 + 局域网（isMultiUserEnabled=false 且非远程请求）→ 落到默认账号，
// 与生产「LAN 开放」语义一致，既有断言全部保持原值。
vi.mock("../../../../lib/workflow-runtime", () => ({  // S5.7：auth-chain 通道 3 现在 import hasLoginPassword（设了密码后
  // 局域网也要登录），漏了它会在 LAN 无凭据用例上炸。
  hasLoginPassword: vi.fn(async () => false),

  getCurrentAccountId: vi.fn(async () => "acct_default"),
  getWorkflowRepository: vi.fn(() => ({ retryFailedWorkflowRun, getWorkflowRunSnapshot })),
  SESSION_COOKIE_NAME: "mt_session",
  DEFAULT_ACCOUNT_ID: "acct_default",
  isMultiUserEnabled: () => false,
  isRemoteRequest: () => false,
  resolveSessionAccountId: async () => null,
  getJwtSecret: async () => "retry-test-secret",
    resolveBearerAccountId: async (headers?: Headers) => {
      const header = headers?.get("authorization");
      // 与真实实现**同一份代码**（lib/bearer-scheme.ts）：此前这里是手抄的正则
      // 复刻版，真实实现退化（如去掉 trim）时这些用例全绿——第四轮复核的 medium。
      const token = parseBearerToken(header);
      if (!token) return null;
      try {
        const claims = await verifyToken(token, "retry-test-secret");
        return claims.sub;
      } catch {
        return null;
      }
    },
}));

import { isDemoMode } from "../../../../lib/demo-mode";
import { POST } from "./route";
import { verifyToken } from "@media-track/shared";
import { parseBearerToken } from "../../../../lib/bearer-scheme";

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/activity/retry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/activity/retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isDemoMode).mockReturnValue(false);
    getWorkflowRunSnapshot.mockResolvedValue(null);
  });

  it("retries non-patrol failed runs and returns the retried result", async () => {
    retryFailedWorkflowRun.mockResolvedValue({ status: "retried" });

    const body = (await (await post({ runId: "r1" })).json()) as Record<string, unknown>;

    expect(body).toEqual({ status: "retried" });
    expect(getWorkflowRunSnapshot).toHaveBeenCalledWith("r1", "acct_default");
  });

  it("creates a new scoped manual search for a failed tracked-season patrol", async () => {
    getWorkflowRunSnapshot.mockResolvedValue({
      accountId: "acct_default",
      connectedStorageId: "drive_1",
      title: { tmdbId: 321, type: "anime" },
      season: { seasonNumber: 2 },
      workflowRun: { id: "r2", kind: "type3_monitor", status: "failed" },
    });
    triggerManualSubscriptionSearch.mockResolvedValue({
      status: "queued",
      workflowRunId: "r2_manual",
      message: "已加入后台队列，完成后可在活动页查看结果。",
    });

    const body = (await (await post({ runId: "r2" })).json()) as Record<string, unknown>;

    expect(body).toMatchObject({ status: "queued", workflowRunId: "r2_manual" });
    expect(triggerManualSubscriptionSearch).toHaveBeenCalledWith({
      accountId: "acct_default",
      tmdbId: 321,
      mediaType: "anime",
      seasonNumber: 2,
      storageId: "drive_1",
      source: "activity",
      sourceWorkflowRunId: "r2",
    });
    expect(retryFailedWorkflowRun).not.toHaveBeenCalled();
  });

  it("returns a clear no-missing result without requeueing the failed patrol", async () => {
    getWorkflowRunSnapshot.mockResolvedValue({
      accountId: "acct_default",
      connectedStorageId: "drive_1",
      title: { tmdbId: 321, type: "tv" },
      season: { seasonNumber: 1 },
      workflowRun: { id: "r2", kind: "type3_monitor", status: "failed" },
    });
    triggerManualSubscriptionSearch.mockResolvedValue({ status: "no_missing", message: "当前没有待搜索的已播缺失资源。" });

    const body = (await (await post({ runId: "r2" })).json()) as Record<string, unknown>;

    expect(body).toMatchObject({ status: "no_missing", message: "当前没有待搜索的已播缺失资源。" });
    expect(retryFailedWorkflowRun).not.toHaveBeenCalled();
  });

  it("does not create a new task for a non-failed patrol", async () => {
    getWorkflowRunSnapshot.mockResolvedValue({
      workflowRun: { id: "r4", kind: "type3_monitor", status: "running" },
    });
    retryFailedWorkflowRun.mockResolvedValue({ status: "not_retriable" });

    const body = (await (await post({ runId: "r4" })).json()) as Record<string, unknown>;

    expect(body).toEqual({ status: "not_retriable", reason: "not_failed" });
    expect(triggerManualSubscriptionSearch).not.toHaveBeenCalled();
  });

  it("reports not_failed for a RUNNING patrol — refused for status, not kind", async () => {
    retryFailedWorkflowRun.mockResolvedValue({ status: "not_retriable" });
    getWorkflowRunSnapshot.mockResolvedValue({
      workflowRun: { id: "r4", kind: "type3_monitor", status: "running" },
    });

    const body = (await (await post({ runId: "r4" })).json()) as Record<string, unknown>;

    expect(body).toEqual({ status: "not_retriable", reason: "not_failed" });
  });

  it("reports not_failed when a claimable run is refused for its status", async () => {
    retryFailedWorkflowRun.mockResolvedValue({ status: "not_retriable" });
    getWorkflowRunSnapshot.mockResolvedValue({
      workflowRun: { id: "r3", kind: "type2_init", status: "running" },
    });

    const body = (await (await post({ runId: "r3" })).json()) as Record<string, unknown>;

    expect(body).toEqual({ status: "not_retriable", reason: "not_failed" });
  });

  it("falls back to not_failed when the run cannot be read", async () => {
    retryFailedWorkflowRun.mockResolvedValue({ status: "not_retriable" });
    getWorkflowRunSnapshot.mockResolvedValue(null);

    const body = (await (await post({ runId: "missing" })).json()) as Record<string, unknown>;

    expect(body).toEqual({ status: "not_retriable", reason: "not_failed" });
  });

  it("rejects a request without a runId", async () => {
    const res = await post({});

    expect(res.status).toBe(400);
    expect(retryFailedWorkflowRun).not.toHaveBeenCalled();
  });

  it("refuses to mutate anything in demo mode", async () => {
    vi.mocked(isDemoMode).mockReturnValue(true);

    const res = await post({ runId: "r1" });

    expect(res.status).toBe(403);
    expect(retryFailedWorkflowRun).not.toHaveBeenCalled();
  });
});
