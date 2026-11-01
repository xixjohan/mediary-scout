import { describe, expect, it, vi } from "vitest";
import { McpCircuitBreaker } from "./mcp-circuit-breaker.js";
import { McpTransportClient } from "./mcp-transport-client.js";
import { ExternalMcpServerStore } from "./mcp-server-store.js";
import type { ExternalMcpServerEntity } from "./mcp-types.js";

describe("Assistant External MCP Integration", () => {
  describe("McpCircuitBreaker", () => {
    it("starts in CLOSED and trips to OPEN after failure threshold", async () => {
      const breaker = new McpCircuitBreaker({ failureThreshold: 3, cooldownMs: 100 });
      expect(breaker.getState()).toBe("CLOSED");

      const failAction = async () => {
        throw new Error("Target MCP service unreachable");
      };

      // 1st failure
      await expect(breaker.execute(failAction)).rejects.toThrow();
      expect(breaker.getState()).toBe("CLOSED");

      // 2nd failure
      await expect(breaker.execute(failAction)).rejects.toThrow();
      expect(breaker.getState()).toBe("CLOSED");

      // 3rd failure -> trips to OPEN
      await expect(breaker.execute(failAction)).rejects.toThrow();
      expect(breaker.getState()).toBe("OPEN");

      // Now fast-fails immediately without running action
      const spy = vi.fn();
      await expect(breaker.execute(spy)).rejects.toThrow(/熔断器处于 OPEN 状态/);
      expect(spy).not.toHaveBeenCalled();

      // Wait for cooldown -> transitions to HALF_OPEN
      await new Promise((resolve) => setTimeout(resolve, 110));
      expect(breaker.getState()).toBe("HALF_OPEN");

      // Successful probe resets circuit to CLOSED
      const successResult = await breaker.execute(async () => "ok");
      expect(successResult).toBe("ok");
      expect(breaker.getState()).toBe("CLOSED");
    });
  });

  describe("McpTransportClient", () => {
    it("handles Streamable HTTP handshake and tools/list JSON-RPC", async () => {
      const entity: ExternalMcpServerEntity = {
        id: "mcp_http_test",
        name: "Test HTTP Server",
        enabled: true,
        transport: "http",
        endpointUrl: "http://127.0.0.1:9999/mcp",
        tools: [],
        createdAt: 1000,
        updatedAt: 1000,
      };

      const client = new McpTransportClient(entity);
      const handshakeResult = await client.handshake();
      expect(handshakeResult.transport).toBe("http");
      expect(handshakeResult.postUrl).toBe("http://127.0.0.1:9999/mcp");

      // Mock global fetch for tools/list JSON-RPC call
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = vi.fn().mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            id: 1,
            result: {
              tools: [
                {
                  name: "fetch_weather",
                  description: "Fetch weather for city",
                  inputSchema: { type: "object", properties: { city: { type: "string" } } },
                },
              ],
            },
          }),
        }) as any;

        const toolsResult = await client.listTools();
        expect(toolsResult.tools.length).toBe(1);
        expect(toolsResult.tools[0]!.name).toBe("fetch_weather");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("parses SSE endpoint event and routes subsequent call to resolved endpoint", async () => {
      const entity: ExternalMcpServerEntity = {
        id: "mcp_sse_test",
        name: "Test SSE Server",
        enabled: true,
        transport: "sse",
        endpointUrl: "http://127.0.0.1:9999/sse",
        tools: [],
        createdAt: 1000,
        updatedAt: 1000,
      };

      const client = new McpTransportClient(entity);
      const originalFetch = globalThis.fetch;
      try {
        // Mock SSE probe returning event: endpoint
        const sseText = "event: endpoint\ndata: /messages?session=xyz\n\n";
        const encoder = new TextEncoder();
        globalThis.fetch = vi.fn().mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/event-stream" }),
          body: {
            getReader: () => ({
              read: async () => ({ value: encoder.encode(sseText), done: false }),
              cancel: async () => {},
            }),
          },
        }) as any;

        const handshakeResult = await client.handshake();
        expect(handshakeResult.transport).toBe("sse");
        expect(handshakeResult.postUrl).toBe("http://127.0.0.1:9999/messages?session=xyz");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("ExternalMcpServerStore", () => {
    it("saves, lists, updates tool toggle, and deletes MCP server", async () => {
      const memory: Record<string, string> = {};
      const mockRepo: any = {
        getSetting: async (k: string) => memory[k] || null,
        setSetting: async (k: string, v: string) => {
          memory[k] = v;
        },
      };

      const store = new ExternalMcpServerStore(mockRepo);
      expect(await store.listServers()).toEqual([]);

      const entity: ExternalMcpServerEntity = {
        id: "mcp_demo",
        name: "Demo MCP Server",
        enabled: true,
        transport: "auto",
        endpointUrl: "http://localhost:3300/mcp",
        tools: [
          { name: "tool_a", enabled: true },
          { name: "tool_b", enabled: false },
        ],
        createdAt: 1000,
        updatedAt: 1000,
      };

      await store.saveServer(entity);
      const list = await store.listServers();
      expect(list.length).toBe(1);
      expect(list[0]!.id).toBe("mcp_demo");

      // Toggle tool
      const ok = await store.updateToolToggle("mcp_demo", "tool_b", true);
      expect(ok).toBe(true);
      const updated = await store.getServer("mcp_demo");
      expect(updated?.tools.find((t) => t.name === "tool_b")?.enabled).toBe(true);

      // Delete
      const deleted = await store.deleteServer("mcp_demo");
      expect(deleted).toBe(true);
      expect((await store.listServers()).length).toBe(0);
    });
  });
});
