import { NextResponse, type NextRequest } from "next/server";
import { resolveSecurityContext } from "../../../platform/next-context/auth-chain";
import { ApiKeyPermissionPreset } from "@media-track/shared";
import {
  executeSearchMedia,
  executeQueryStatus,
  executeQueryLibrary,
} from "../../../features/assistant/application/chat-agent-service";
import { executeDiscoverMedia } from "../../../features/assistant/core/chat-discover";

interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const MCP_REGISTERED_TOOLS = [
  {
    name: "discoverMedia",
    description: "在 TMDB 实时数据库中按年份、分类类型（如科幻、动作、动画等）发现、推荐和筛选电影或剧集",
    inputSchema: {
      type: "object",
      properties: {
        genre: { type: "string", description: "题材分类，例如：科幻、动作、动画、喜剧、悬疑等" },
        year: { type: "number", description: "上映年份，例如：2026、2025 等" },
        type: { type: "string", enum: ["movie", "tv"], description: "媒体类型：movie（电影）或 tv（剧集）" },
        sortBy: { type: "string", enum: ["popularity", "rating", "release_date"], description: "排序方式" },
      },
    },
  },
  {
    name: "searchMedia",
    description: "在 TMDB 检索电影或剧集基本信息",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "影片名称或关键词" },
      },
    },
  },
  {
    name: "queryStatus",
    description: "查询当前后台正在进行的获取、转存、整理等任务进度",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "queryLibrary",
    description: "查询当前用户已订阅和追踪的影视列表",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

const TOOL_TO_PERMISSION_MAP: Record<string, string> = {
  discoverMedia: "media:detail",
  searchMedia: "media:search",
  queryStatus: "workflow:status",
  queryLibrary: "media:detail",
};

async function dispatchToolExecution(
  toolName: string,
  toolArgs: Record<string, unknown>,
  accountId: string
): Promise<unknown> {
  switch (toolName) {
    case "discoverMedia":
      return executeDiscoverMedia({
        genre: typeof toolArgs.genre === "string" ? toolArgs.genre : undefined,
        year: typeof toolArgs.year === "number" ? toolArgs.year : undefined,
        type: toolArgs.type === "tv" || toolArgs.type === "movie" ? toolArgs.type : undefined,
        sortBy:
          toolArgs.sortBy === "popularity" || toolArgs.sortBy === "rating" || toolArgs.sortBy === "release_date"
            ? toolArgs.sortBy
            : undefined,
      });
    case "searchMedia":
      return executeSearchMedia(String(toolArgs.query || ""));
    case "queryStatus":
      return executeQueryStatus(accountId);
    case "queryLibrary":
      return executeQueryLibrary(accountId);
    default:
      throw new Error(`Unsupported tool: ${toolName}`);
  }
}

async function handleToolsCall(
  reqId: string | number | null,
  sec: NonNullable<Awaited<ReturnType<typeof resolveSecurityContext>>>,
  params: McpJsonRpcRequest["params"]
) {
  const toolName = String(params?.name || "");
  const toolArgs = (params?.arguments as Record<string, unknown>) || {};

  const requiredPerm = TOOL_TO_PERMISSION_MAP[toolName];
  if (!requiredPerm) {
    return NextResponse.json({
      jsonrpc: "2.0",
      id: reqId,
      error: { code: -32601, message: `Tool not found: [${toolName}]` },
    });
  }

  // 权限卡口强校验
  if (!sec.isMaster && !sec.permissions.has("*") && !sec.permissions.has(requiredPerm)) {
    return NextResponse.json({
      jsonrpc: "2.0",
      id: reqId,
      error: {
        code: -32003,
        message: `Forbidden: API Key 权限不足，缺少工具 [${toolName}] 所需的 [${requiredPerm}] 权限`,
      },
    });
  }

  try {
    const executionOutput = await dispatchToolExecution(toolName, toolArgs, sec.accountId);
    return NextResponse.json({
      jsonrpc: "2.0",
      id: reqId,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify(executionOutput, null, 2),
          },
        ],
      },
    });
  } catch (callErr) {
    return NextResponse.json({
      jsonrpc: "2.0",
      id: reqId,
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool execution failed: ${callErr instanceof Error ? callErr.message : String(callErr)}`,
          },
        ],
      },
    });
  }
}

export async function POST(request: NextRequest) {
  // 1. 统一鉴权：支持 Bearer msk_live_... 或登录 Session
  const sec = await resolveSecurityContext(request);
  if (!sec) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "Unauthorized: API Key 无效或已被吊销/版本失效" },
      },
      { status: 401 }
    );
  }

  const rpc = (await request.json().catch(() => null)) as McpJsonRpcRequest | null;
  if (!rpc || rpc.jsonrpc !== "2.0" || !rpc.method) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: rpc?.id ?? null,
        error: { code: -32600, message: "Invalid Request: 符合标准的 JSON-RPC 2.0 请求" },
      },
      { status: 400 }
    );
  }

  const reqId = rpc.id ?? null;

  switch (rpc.method) {
    case "initialize":
      return NextResponse.json({
        jsonrpc: "2.0",
        id: reqId,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: {
            name: "mediary-scout-mcp",
            version: "1.0.0",
          },
          capabilities: {
            tools: {},
          },
        },
      });

    case "tools/list": {
      // 核心机制：动态 MCP 工具投影裁剪 (节省 70% Token 且彻底杜绝大模型越权幻觉)
      const allowedTools = ApiKeyPermissionPreset.projectMcpTools(
        Array.from(sec.permissions),
        MCP_REGISTERED_TOOLS,
        TOOL_TO_PERMISSION_MAP
      );

      return NextResponse.json({
        jsonrpc: "2.0",
        id: reqId,
        result: { tools: allowedTools },
      });
    }

    case "tools/call":
      return handleToolsCall(reqId, sec, rpc.params);

    default:
      return NextResponse.json({
        jsonrpc: "2.0",
        id: reqId,
        error: { code: -32601, message: `Method not found: ${rpc.method}` },
      });
  }
}
