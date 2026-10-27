import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("../../../../lib/workflow-runtime", async () => {
  const actual = await vi.importActual<typeof import("../../../../lib/workflow-runtime")>(
    "../../../../lib/workflow-runtime",
  );
  return {
    isRemoteRequest: actual.isRemoteRequest,
    isMultiUserEnabled: vi.fn(() => false),
    hasLoginPassword: vi.fn(async () => false),
    getBootstrapState: vi.fn(async () => ({ needsClaim: true, hasExistingLibrary: false })),
  };
});

import { GET } from "./route";
import * as runtime from "../../../../lib/workflow-runtime";

const TUNNEL = { "cf-ray": "8f3-abc", "cf-connecting-ip": "203.0.113.7" };
const get = (headers: Record<string, string> = {}) =>
  GET(new NextRequest("http://localhost:3000/api/auth/bootstrap", { headers }));

describe("GET /api/auth/bootstrap", () => {
  beforeEach(() => {
    // resetAllMocks 而非 clearAllMocks：后者只清调用记录，本文件里
    // isMultiUserEnabled 的 mockReturnValue(true) 会泄漏到同 worker 的后续
    // 文件——--sequence.shuffle 下必红，固定顺序下看不见（第四轮复核实测）。
    // 还原三处实现的返回值，让每个用例都从同一状态起步。
    vi.resetAllMocks();
    vi.mocked(runtime.isMultiUserEnabled).mockReturnValue(false);
    vi.mocked(runtime.hasLoginPassword).mockResolvedValue(false);
    vi.mocked(runtime.getBootstrapState).mockResolvedValue({ needsClaim: true, hasExistingLibrary: false });
  });

  it("tells the login page whether the visitor came through the tunnel (single user)", async () => {
    expect(await (await get(TUNNEL)).json()).toMatchObject({ singleUser: true, passwordSet: false, remote: true });
    expect(await (await get()).json()).toMatchObject({ singleUser: true, passwordSet: false, remote: false });
  });

  it("tells the login page whether the visitor came through the tunnel (multi user)", async () => {
    vi.mocked(runtime.isMultiUserEnabled).mockReturnValue(true);
    expect(await (await get(TUNNEL)).json()).toMatchObject({ singleUser: false, needsClaim: true, remote: true });
  });
});
