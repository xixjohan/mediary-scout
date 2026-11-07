import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { InMemoryWorkflowRepository } from "@media-track/workflow";
import { DELETE, GET, POST, PUT } from "./route";
import { requireApiAccount } from "../../../../../lib/auth-chain";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("../../../../../lib/auth-chain", () => ({ requireApiAccount: vi.fn() }));
vi.mock("../../../../../lib/workflow-runtime", () => ({ getWorkflowRepository: () => repo }));

const repo = new InMemoryWorkflowRepository();
const policy = {
  mustContain: ["1080p"], mustNotContain: ["CAM"], episodeFilter: "", useRegex: false, cooldownDays: 0,
  priorityGroups: [{ id: "preferred", name: "优先", mustContain: ["remux"], mustNotContain: [] }],
};
const request = (method: string, body?: unknown) => new NextRequest("http://localhost/api/titles/subscription-policy/templates", {
  method,
  ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
});

beforeEach(() => { vi.mocked(requireApiAccount).mockResolvedValue("acct_templates" as never); });
afterEach(() => vi.clearAllMocks());

describe("subscription policy template API", () => {
  it("saves and lists a scoped copy of a policy, then deletes only for its owner", async () => {
    const createdResponse = await POST(request("POST", { name: "动漫 1080p", policy }) as never);
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(created.template.policy.priorityGroups).toEqual(policy.priorityGroups);
    expect((await (await GET(request("GET") as never)).json()).templates).toHaveLength(1);
    expect(await repo.listSubscriptionPolicyTemplates("acct_other")).toEqual([]);
    expect((await DELETE(request("DELETE", { id: created.template.id }) as never)).status).toBe(200);
    expect((await (await GET(request("GET") as never)).json()).templates).toEqual([]);
  });

  it("rejects invalid names and malformed priority groups", async () => {
    expect((await POST(request("POST", { name: " ", policy }) as never)).status).toBe(400);
    expect((await POST(request("POST", { name: "ok", policy: { ...policy, priorityGroups: new Array(9).fill({ id: "g", name: "g" }) } }) as never)).status).toBe(400);
  });

  it("updates a template without changing account ownership", async () => {
    const created = await (await POST(request("POST", { name: "原模板", policy }) as never)).json();
    const response = await PUT(request("PUT", { id: created.template.id, name: "更新模板", policy: { ...policy, mustContain: ["2160p"] } }) as never);
    expect(response.status).toBe(200);
    expect((await response.json()).template).toMatchObject({ name: "更新模板", policy: { mustContain: ["2160p"] } });

    vi.mocked(requireApiAccount).mockResolvedValue("acct_other" as never);
    expect((await PUT(request("PUT", { id: created.template.id, name: "越权", policy }) as never)).status).toBe(404);
  });
});
