import { describe, expect, it, vi, beforeEach } from "vitest";
import { StorageOwnedByOtherAccountError } from "../../../../../lib/workflow-runtime";
import { Pan115QrExchangeError } from "@media-track/workflow";

vi.mock("../../../../../lib/demo-mode", () => ({ isDemoMode: () => false }));
// Mock completePan115QrLogin so we can throw controlled errors. Keep the class
// symbol real (re-exported) so `instanceof` in the route still works.
vi.mock("../../../../../lib/workflow-runtime", async () => {
  const actual = await vi.importActual<typeof import("../../../../../lib/workflow-runtime")>(
    "../../../../../lib/workflow-runtime",
  );
  return {
    ...actual,
    StorageOwnedByOtherAccountError: actual.StorageOwnedByOtherAccountError,
    completePan115QrLogin: vi.fn(),
  };
});

import { POST } from "./route";
import { completePan115QrLogin } from "../../../../../lib/workflow-runtime";
import { NextRequest } from "next/server";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/115/qrcode/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = { session: { uid: "u", time: 1, sign: "s" } };

describe("POST /api/115/qrcode/confirm — error mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 409 + clean message when the drive is owned by another account", async () => {
    (completePan115QrLogin as ReturnType<typeof vi.fn>).mockRejectedValue(
      new StorageOwnedByOtherAccountError(),
    );
    const res = await POST(req(validBody));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("该网盘账号已被本实例的其他用户连接，无法重复绑定。");
    expect(body.error).not.toMatch(/Error:|StorageOwned/);
  });

  it("returns 422 (not 502) when upstream rejects exchange (e.g. discontinued channel)", async () => {
    (completePan115QrLogin as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Pan115QrExchangeError("登录失败，系统已下架！", 40101017),
    );
    const res = await POST(req(validBody));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("PAN115_QR_EXCHANGE_FAILED: 登录失败，系统已下架！");
  });

  it("returns 502 + expanded cause message for network/infra errors", async () => {
    const netErr = new Error("fetch failed");
    (netErr as unknown as { cause: Error }).cause = new Error("Client network socket disconnected");
    (completePan115QrLogin as ReturnType<typeof vi.fn>).mockRejectedValue(netErr);
    const res = await POST(req(validBody));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("fetch failed (Client network socket disconnected)");
  });

  it("returns 502 + bare message for other (infra) errors", async () => {
    (completePan115QrLogin as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("upstream 500"));
    const res = await POST(req(validBody));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("upstream 500");
    expect(body.error).not.toMatch(/^Error:/);
  });

  it("returns 400 when session params are missing", async () => {
    const res = await POST(req({ session: {} }));
    expect(res.status).toBe(400);
  });

  it("returns 400 (not 502) when the request body is invalid JSON", async () => {
    const r = new NextRequest("http://localhost/api/115/qrcode/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const res = await POST(r);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
