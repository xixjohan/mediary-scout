import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("../../../../lib/workflow-runtime", () => ({
  SESSION_COOKIE_NAME: "mt_session",
  isCookieSecure: vi.fn(() => false),
  logoutSession: vi.fn(),
}));

import { POST } from "./route";
import * as runtime from "../../../../lib/workflow-runtime";

describe("POST /api/auth/logout", () => {
  it("clears session and returns 200", async () => {
    const req = new NextRequest("http://localhost:3000/api/auth/logout", {
      method: "POST",
      headers: {
        cookie: "mt_session=session_123",
      },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(runtime.logoutSession).toHaveBeenCalledWith("session_123");

    const cookieHeader = res.headers.get("set-cookie");
    expect(cookieHeader).toContain("mt_session=");
    expect(cookieHeader).toContain("Max-Age=0");
  });
});
