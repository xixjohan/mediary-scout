export type McpTransportType = "sse" | "http" | "auto";

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  enabled?: boolean;
}

export interface ExternalMcpServerEntity {
  id: string; // "mcp_xxx"
  name: string;
  enabled: boolean;
  transport: McpTransportType;
  endpointUrl: string;
  apiKey?: string | undefined;
  timeoutMs?: number | undefined; // default 8000
  tools: McpToolSchema[];
  createdAt: number;
  updatedAt: number;
  lastTestedAt?: number | null | undefined;
  lastError?: string | null | undefined;
}

export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown> | undefined;
}

export interface McpJsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpToolsListResult {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
}

export interface McpCallToolResult {
  content?: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}
