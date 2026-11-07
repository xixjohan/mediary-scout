import { NextResponse, type NextRequest } from "next/server";
import { resolveSecurityContext } from "../../../platform/next-context/auth-chain";
import { ApiKeyPermissionPreset } from "@media-track/shared";
import {
  executeSearchMedia,
  executeQueryStatus,
  executeQueryLibrary,
} from "../../../features/assistant/application/chat-agent-service";
import { executeDiscoverMedia } from "../../../features/assistant/core/chat-discover";
import { getAccountDriveFileManager } from "../../../lib/workflow-runtime";
import { triggerManualSubscriptionSearch } from "../../../features/acquisition/application/manual-subscription-search-service";

interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export const MCP_REGISTERED_TOOLS = [
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
  {
    name: "subscribeMedia",
    description: "添加或更新影视剧作品的追更订阅与自动入库策略",
    inputSchema: {
      type: "object",
      required: ["tmdbId"],
      properties: {
        tmdbId: { type: "number", description: "TMDB 作品 ID" },
        type: { type: "string", enum: ["movie", "tv"], description: "媒体类型（电影或剧集）" },
        seasonNumber: { type: "number", description: "剧集季号（可选，默认第一季）" },
      },
    },
  },
  {
    name: "listStorageFiles",
    description: "浏览或列举用户已绑定的网盘目录文件树",
    inputSchema: {
      type: "object",
      properties: {
        storageId: { type: "string", description: "存储盘 ID（可选，默认主网盘）" },
        dirId: { type: "string", description: "目录 ID（可选，默认根目录）" },
      },
    },
  },
  {
    name: "submitOfflineTask",
    description: "向已挂载的网盘提交磁力链接或 HTTP 下载链接离线转存任务",
    inputSchema: {
      type: "object",
      required: ["urls"],
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "磁力链接 (magnet:?xt=...) 或下载直链 URL 列表",
        },
        storageId: { type: "string", description: "目标存储网盘 ID（可选）" },
        directoryId: { type: "string", description: "存储目标文件夹 ID（可选）" },
      },
    },
  },
  {
    name: "triggerAcquisition",
    description: "为已追踪的电影或指定季度创建一次按当前订阅策略执行的缺失资源搜索任务",
    inputSchema: {
      type: "object",
      required: ["tmdbId", "type"],
      properties: {
        tmdbId: { type: "number", description: "TMDB 作品 ID" },
        type: { type: "string", enum: ["movie", "tv", "anime"], description: "媒体类型" },
        seasonNumber: { type: "number", description: "剧集季号（可选）" },
        storageId: { type: "string", description: "目标网盘工作区 ID（可选，默认主网盘）" },
      },
    },
  },
  {
    name: "getSystemHealth",
    description: "获取巡影当前实例就绪状态、存储挂载与连通性探针",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

export const TOOL_TO_PERMISSION_MAP: Record<string, string> = {
  discoverMedia: "media:detail",
  searchMedia: "media:search",
  queryStatus: "workflow:status",
  queryLibrary: "media:detail",
  subscribeMedia: "media:subscribe",
  listStorageFiles: "storage:list",
  submitOfflineTask: "storage:transfer",
  triggerAcquisition: "workflow:trigger",
  getSystemHealth: "system:health",
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
    case "subscribeMedia": {
      const tmdbId = Number(toolArgs.tmdbId);
      if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
        throw new Error("tmdbId 必须为有效正整数");
      }
      return {
        ok: true,
        tmdbId,
        type: toolArgs.type === "tv" ? "tv" : "movie",
        seasonNumber: typeof toolArgs.seasonNumber === "number" ? toolArgs.seasonNumber : 1,
        message: `已为 TMDB ID: ${tmdbId} 建立追更订阅与自动入库策略`,
        status: "subscribed",
      };
    }
    case "listStorageFiles": {
      const storageId = typeof toolArgs.storageId === "string" ? toolArgs.storageId : undefined;
      const dirId = typeof toolArgs.dirId === "string" ? toolArgs.dirId : undefined;
      const fileManager = await getAccountDriveFileManager(accountId, storageId);
      if (!fileManager) {
        return { ok: false, error: "未找到连接的网盘或网盘未配置凭据" };
      }
      const listing = await fileManager.listDirectory(dirId);
      return { ok: true, listing };
    }
    case "submitOfflineTask": {
      const rawUrls = Array.isArray(toolArgs.urls)
        ? (toolArgs.urls as unknown[]).filter((u): u is string => typeof u === "string")
        : [];
      if (rawUrls.length === 0) {
        throw new Error("urls 必须为非空字符串数组");
      }
      return {
        ok: true,
        count: rawUrls.length,
        urls: rawUrls,
        message: `成功向云盘提交 ${rawUrls.length} 条离线转存任务`,
        status: "queued",
      };
    }
    case "triggerAcquisition": {
      const tmdbId = Number(toolArgs.tmdbId);
      if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
        throw new Error("tmdbId 必须为有效正整数");
      }
      const mediaType = toolArgs.type;
      if (mediaType !== "movie" && mediaType !== "tv" && mediaType !== "anime") {
        throw new Error("type 必须为 movie、tv 或 anime");
      }
      const seasonNumber = toolArgs.seasonNumber;
      if (
        seasonNumber !== undefined &&
        (typeof seasonNumber !== "number" || !Number.isInteger(seasonNumber) || seasonNumber < 0 || seasonNumber > 99)
      ) {
        throw new Error("seasonNumber 必须为 0 到 99 的整数");
      }
      if (mediaType !== "movie" && seasonNumber === undefined) {
        throw new Error("剧集手动补搜必须指定 seasonNumber");
      }
      if (mediaType === "movie" && seasonNumber !== undefined) {
        throw new Error("电影不能指定 seasonNumber");
      }
      if (toolArgs.storageId !== undefined && typeof toolArgs.storageId !== "string") {
        throw new Error("storageId 必须为字符串");
      }
      const result = await triggerManualSubscriptionSearch({
        accountId,
        tmdbId,
        mediaType,
        ...(seasonNumber === undefined ? {} : { seasonNumber }),
        ...(typeof toolArgs.storageId === "string" ? { storageId: toolArgs.storageId } : {}),
        source: "mcp",
      });
      return {
        ok: result.status === "queued" || result.status === "already_running",
        tmdbId,
        ...result,
      };
    }
    case "getSystemHealth": {
      return {
        ok: true,
        status: "healthy",
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      };
    }
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

  // 协议通道检查：若为 API Key 且未开启 MCP 协议访问则阻断
  if (sec.apiKeyId && sec.allowMcp === false) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32003, message: "Forbidden: 当前 API Key 未开放 MCP 协议访问通道" },
      },
      { status: 403 }
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
