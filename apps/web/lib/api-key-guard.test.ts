import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { enforceApiAuth, resolveRequestAuth } from "./api-key-guard";
import { issueToken } from "@media-track/shared";
import {
  setApiKeyV2StoreForTest,
  resetRuntimeContainerForTests,
} from "../composition/runtime-container";
import { ApiKeyV2Store } from "@media-track/workflow";

const JWT_SECRET = "guard-test-jwt-secret-32-chars-long!";

vi.mock("./workflow-runtime", () => ({
  SESSION_COOKIE_NAME: "mt_session",
  DEFAULT_ACCOUNT_ID: "acct_admin",
  isMultiUserEnabled: () => false,
  isRemoteRequest: () => false,
  hasLoginPassword: async () => true, // 启用密码保护
  resolveSessionAccountId: async (cookie: string) => {
    return cookie === "valid_session" ? "acct_admin" : null;
  },
  getJwtSecret: async () => JWT_SECRET,
}));

describe("ApiKeyGuard & Privilege Escalation Defenses", () => {
  let mockStore: {
    findKeyByPlainToken: (token: string) => Promise<any>;
    touchLastUsed: (id: string) => Promise<void>;
  };

  beforeEach(() => {
    resetRuntimeContainerForTests();
    mockStore = {
      findKeyByPlainToken: async (token: string) => {
        if (token === "msk_live_valid12345678") {
          return {
            id: "key_media_only",
            name: "Media Reader",
            permissions: ["media:search", "media:detail"],
            maskedKey: "msk_live_val...5678",
          };
        }
        return null;
      },
      touchLastUsed: async () => {},
    };
    setApiKeyV2StoreForTest(mockStore as unknown as ApiKeyV2Store);
  });

  it("identifies AdminSession from session cookie", async () => {
    const req = new NextRequest("http://localhost:3000/api/tunnel/lines", {
      headers: {
        cookie: "mt_session=valid_session",
      },
    });

    const auth = await resolveRequestAuth(req);
    expect(auth.accountId).toBe("acct_admin");
    expect(auth.tokenType).toBe("AdminSession");

    // Admin session can access management route
    const verdict = await enforceApiAuth(req);
    expect(verdict).toEqual({ accountId: "acct_admin" });
  });

  it("identifies ApiKey from Bearer JWT and blocks access to management routes (403)", async () => {
    const jwt = await issueToken(
      {
        sub: "acct_admin",
        tokenType: "ApiKey",
        keyId: "key_sub_scoped",
        permissions: ["media:search"],
      },
      JWT_SECRET,
      3600
    );

    // 1. Attempt accessing forbidden tunnel path
    const tunnelReq = new NextRequest("http://localhost:3000/api/tunnel/lines", {
      headers: {
        authorization: `Bearer ${jwt}`,
      },
    });

    const tunnelVerdict = await enforceApiAuth(tunnelReq);
    expect(tunnelVerdict instanceof Response).toBe(true);
    if (tunnelVerdict instanceof Response) {
      expect(tunnelVerdict.status).toBe(403);
      const data = await tunnelVerdict.json();
      expect(data.error).toContain("403 Forbidden: API Key 无权访问管理或安全配置端点");
    }

    // 2. Attempt accessing forbidden auth path
    const authReq = new NextRequest("http://localhost:3000/api/auth/token", {
      headers: {
        authorization: `Bearer ${jwt}`,
      },
    });
    const authVerdict = await enforceApiAuth(authReq);
    if (authVerdict instanceof Response) {
      expect(authVerdict.status).toBe(403);
    }
  });

  it("identifies raw ApiKey from Authorization or X-Api-Key header", async () => {
    const req = new NextRequest("http://localhost:3000/api/titles/resources", {
      headers: {
        "x-api-key": "msk_live_valid12345678",
      },
    });

    const auth = await resolveRequestAuth(req);
    expect(auth.tokenType).toBe("ApiKey");
    expect(auth.keyId).toBe("key_media_only");
    expect(auth.permissions).toContain("media:search");

    // Permitted action succeeds
    const okVerdict = await enforceApiAuth(req, "media:search");
    expect(okVerdict).toEqual({ accountId: "acct_admin" });

    // Unauthorized action returns 403
    const deniedVerdict = await enforceApiAuth(req, "storage:delete");
    expect(deniedVerdict instanceof Response).toBe(true);
    if (deniedVerdict instanceof Response) {
      expect(deniedVerdict.status).toBe(403);
      const data = await deniedVerdict.json();
      expect(data.error).toContain("缺少必要权限 [storage:delete]");
    }
  });
});
