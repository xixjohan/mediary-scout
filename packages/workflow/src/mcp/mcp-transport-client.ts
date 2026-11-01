import type {
  ExternalMcpServerEntity,
  McpCallToolResult,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpToolsListResult,
  McpTransportType,
} from "./mcp-types.js";
import { McpCircuitBreaker } from "./mcp-circuit-breaker.js";

export class McpTransportClient {
  private _nextRequestId = 1;
  private readonly _circuitBreaker: McpCircuitBreaker;
  private _resolvedTransport: McpTransportType;
  private _postUrl: string;

  constructor(public readonly config: ExternalMcpServerEntity) {
    this._circuitBreaker = new McpCircuitBreaker();
    this._resolvedTransport = config.transport;
    this._postUrl = config.endpointUrl;
  }

  public getCircuitBreaker(): McpCircuitBreaker {
    return this._circuitBreaker;
  }

  public getResolvedTransport(): McpTransportType {
    return this._resolvedTransport;
  }

  /**
   * 自动探测或握手服务传输通道（SSE 或 Streamable HTTP）
   */
  public async handshake(): Promise<{ transport: "sse" | "http"; postUrl: string }> {
    const timeout = this.config.timeoutMs || 8000;
    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    if (this.config.transport === "http") {
      this._resolvedTransport = "http";
      this._postUrl = this.config.endpointUrl;
      return { transport: "http", postUrl: this._postUrl };
    }

    if (this.config.transport === "sse") {
      const sseResult = await this._probeSse(headers, timeout);
      this._resolvedTransport = "sse";
      this._postUrl = sseResult.postUrl;
      return { transport: "sse", postUrl: this._postUrl };
    }

    // transport === "auto" 自动探测
    try {
      const sseResult = await this._probeSse(headers, timeout);
      this._resolvedTransport = "sse";
      this._postUrl = sseResult.postUrl;
      return { transport: "sse", postUrl: this._postUrl };
    } catch {
      // 降级使用 Streamable HTTP
      this._resolvedTransport = "http";
      this._postUrl = this.config.endpointUrl;
      return { transport: "http", postUrl: this._postUrl };
    }
  }

  private async _probeSse(
    headers: Record<string, string>,
    timeoutMs: number
  ): Promise<{ postUrl: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(this.config.endpointUrl, {
        method: "GET",
        headers: {
          ...headers,
          Accept: "text/event-stream",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`SSE probe failed with status ${response.status}`);
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream")) {
        throw new Error(`Endpoint did not return text/event-stream (got ${contentType})`);
      }

      // 读取首包解析 endpoint 事件（若有）
      const reader = response.body?.getReader();
      if (!reader) {
        return { postUrl: this.config.endpointUrl };
      }

      try {
        const { value } = await reader.read();
        if (value) {
          const text = new TextDecoder().decode(value);
          const lines = text.split("\n");
          let isEndpointEvent = false;
          for (const line of lines) {
            if (line.startsWith("event: endpoint")) {
              isEndpointEvent = true;
            } else if (isEndpointEvent && line.startsWith("data: ")) {
              const relOrAbs = line.slice(6).trim();
              const resolved = new URL(relOrAbs, this.config.endpointUrl).toString();
              return { postUrl: resolved };
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }

      return { postUrl: this.config.endpointUrl };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 发送标准 JSON-RPC 2.0 请求（受 8s 硬超时与熔断器保护）
   */
  public async callJsonRpc<T>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    return this._circuitBreaker.execute(async () => {
      const timeoutMs = this.config.timeoutMs || 8000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const requestBody: McpJsonRpcRequest = {
        jsonrpc: "2.0",
        id: this._nextRequestId++,
        method,
        params,
      };

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };
      if (this.config.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      }

      try {
        const response = await fetch(this._postUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          throw new Error(
            `MCP HTTP 调用失败: HTTP ${response.status} ${response.statusText} (${errText.slice(0, 200)})`
          );
        }

        const data = (await response.json()) as McpJsonRpcResponse<T>;
        if (data.error) {
          throw new Error(`MCP JSON-RPC 错误 [${data.error.code}]: ${data.error.message}`);
        }

        return data.result as T;
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /**
   * 查询外部 MCP 工具列表
   */
  public async listTools(): Promise<McpToolsListResult> {
    await this.handshake();
    return this.callJsonRpc<McpToolsListResult>("tools/list");
  }

  /**
   * 执行指定外部 MCP 工具
   */
  public async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<McpCallToolResult> {
    return this.callJsonRpc<McpCallToolResult>("tools/call", {
      name,
      arguments: args,
    });
  }
}
