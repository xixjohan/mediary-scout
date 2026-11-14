import { describe, expect, it } from "vitest";
import type { ToolSet } from "ai";
import { buildSandboxToolSet } from "../../src/acquisition-v2/agent-loop.js";
import type { ToolCallMeta } from "../../src/acquisition-v2/agent-tool-wrap.js";
import type { TaskSandbox } from "../../src/acquisition-v2/sandbox.js";

type ExecutableTool = { execute: (args: unknown, options: unknown) => Promise<unknown> };
type Captured = { name: string; args: Record<string, unknown>; meta: ToolCallMeta };

function capture() {
  const calls: Captured[] = [];
  const onToolCall = (name: string, args: Record<string, unknown>, meta: ToolCallMeta) => {
    calls.push({ name, args, meta });
  };
  return { calls, onToolCall };
}

describe("buildSandboxToolSet onToolCall", () => {
  it("emits a start then an end event per call, correlated by callId, and still returns the result", async () => {
    const { calls, onToolCall } = capture();
    const fakeSandbox = {
      searchResources: async (keyword: string) => ({ keyword, candidates: [] }),
    } as unknown as TaskSandbox;

    const tools = buildSandboxToolSet(fakeSandbox, { onToolCall }) as ToolSet & Record<string, ExecutableTool>;
    const result = await tools.searchResources!.execute({ keyword: "斗破苍穹" }, {});

    expect(result).toMatchObject({ keyword: "斗破苍穹" });
    expect(calls).toHaveLength(2);
    const [start, end] = calls;
    expect(start!.name).toBe("searchResources");
    expect(start!.args).toEqual({ keyword: "斗破苍穹" });
    expect(start!.meta.kind).toBe("start");
    expect(start!.meta.status).toBeUndefined();
    expect(end!.meta.kind).toBe("end");
    expect(end!.meta.callId).toBe(start!.meta.callId);
    expect(end!.meta.status).toBe("succeeded");
    expect(typeof end!.meta.endedAt).toBe("string");
  });

  it("marks a guard-refusal { error } result as failed with the structured message", async () => {
    const { calls, onToolCall } = capture();
    const fakeSandbox = {
      searchResources: async () => {
        throw new Error("预算已用尽");
      },
    } as unknown as TaskSandbox;

    const tools = buildSandboxToolSet(fakeSandbox, { onToolCall }) as ToolSet & Record<string, ExecutableTool>;
    const result = await tools.searchResources!.execute({ keyword: "x" }, {});

    expect(result).toMatchObject({ error: "预算已用尽" });
    const end = calls.find((c) => c.meta.kind === "end");
    expect(end!.meta.status).toBe("failed");
    expect(end!.meta.error).toBe("预算已用尽");
  });

  it("a throwing onToolCall never breaks the tool execution", async () => {
    const fakeSandbox = {
      searchResources: async (keyword: string) => ({ keyword }),
    } as unknown as TaskSandbox;

    const tools = buildSandboxToolSet(fakeSandbox, {
      onToolCall: () => {
        throw new Error("sink blew up");
      },
    }) as ToolSet & Record<string, ExecutableTool>;

    await expect(tools.searchResources!.execute({ keyword: "x" }, {})).resolves.toMatchObject({ keyword: "x" });
  });

  it("without onToolCall or logging the toolset is returned unwrapped (passthrough)", () => {
    const fakeSandbox = { searchResources: async () => ({}) } as unknown as TaskSandbox;
    const tools = buildSandboxToolSet(fakeSandbox);
    expect(typeof (tools as Record<string, ExecutableTool>).searchResources!.execute).toBe("function");
  });
});