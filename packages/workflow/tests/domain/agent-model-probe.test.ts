import { describe, expect, it, vi } from "vitest";
import { createAgentModel } from "../../src/domain/agent-model.js";
import { probeAgentModel } from "../../src/domain/agent-model-probe.js";

function reply(message: object, finishReason = "stop") {
  return Response.json({
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finishReason }],
  });
}

const callProbe = () => reply({
  tool_calls: [{
    id: "call_probe", type: "function",
    function: { name: "checkConnection", arguments: '{"challenge":"ping"}' },
  }],
}, "tool_calls");

function model(fetch: typeof globalThis.fetch) {
  return createAgentModel({ baseURL: "https://example.com/v1", modelId: "mock", fetch });
}

describe("probeAgentModel", () => {
  it("requires a tool call and verifies the result was sent back on the second request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => callProbe())
      .mockImplementationOnce(async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        const toolResult = request.messages.find((message: { role: string }) => message.role === "tool");
        expect(toolResult.tool_call_id).toBe("call_probe");
        expect(toolResult.content).toMatch(/^[0-9a-f-]{36}$/);
        return reply({ content: toolResult.content });
      });
    expect(await probeAgentModel(model(fetch))).toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports plain text as missing tool capability", async () => {
    const fetch = vi.fn(async () => reply({ content: "ping" }));
    expect(await probeAgentModel(model(fetch))).toMatchObject({ ok: false, stage: "tool_call" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports a bad second round separately", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => callProbe())
      .mockImplementationOnce(async () => reply({ content: "unrelated" }));
    expect(await probeAgentModel(model(fetch))).toMatchObject({ ok: false, stage: "tool_result" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses one deadline for both requests", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => callProbe())
      .mockImplementationOnce(async (_url, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
    const result = await probeAgentModel(model(fetch), 100);
    expect(result).toMatchObject({ ok: false, stage: "tool_result", message: expect.stringContaining("超时") });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports transport errors without echoing response text or retrying", async () => {
    const secret = "sk-test-super-secret-12345";
    const fetch = vi.fn(async () => Response.json({ error: { message: secret } }, { status: 503 }));
    const result = await probeAgentModel(model(fetch));
    expect(result).toMatchObject({ ok: false, stage: "connection" });
    expect(result.message).not.toContain(secret);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
