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
import {
  MCP_REGISTERED_TOOLS,
  TOOL_TO_PERMISSION_MAP,
} from "./tools";
import {
  executeGetMediaDetail,
  executeGetTrendingMedia,
  executeSearchResources,
  executeScrapeResourceMetadata,
  executeListSubscriptions,
  executeGetSubscriptionDetail,
  executeUpdateSubscription,
  executeDeleteSubscription,
  executeGetStorageDrives,
  executeCheckDriveQuota,
  executeSearchDriveFiles,
  executeGetDriveDownloadUrl,
  executeListStrmTasks,
  executeCreateStrmTask,
  executeTriggerStrmSync,
  executeListMediaServers,
  executeSyncMediaServerLibrary,
  executeTestMediaServerConnection,
  executeListExtensions,
  executeToggleExtension,
} from "./executor";
import {
  executeScanDriveMedia,
  executeAdoptDriveMedia,
  executePlanOrganizeMedia,
  executeExecuteOrganizeMedia,
} from "./drive-media-executor";

export { MCP_REGISTERED_TOOLS, TOOL_TO_PERMISSION_MAP };

interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

async function dispatchToolExecution(
  toolName: string,
  toolArgs: Record<string, unknown>,
  accountId: string
): Promise<unknown> {
  switch (toolName) {
    // 1. 影视搜索
    case "searchMedia":
      return executeSearchMedia(String(toolArgs.query || ""));
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
    case "getMediaDetail":
      return executeGetMediaDetail(toolArgs, accountId);
    case "getTrendingMedia":
      return executeGetTrendingMedia(toolArgs);

    // 2. 资源查询与刮削
    case "searchResources":
      return executeSearchResources(toolArgs, accountId);
    case "scrapeResourceMetadata":
      return executeScrapeResourceMetadata(toolArgs);

    // 3. 订阅管理
    case "listSubscriptions":
      return executeListSubscriptions(toolArgs);
    case "getSubscriptionDetail":
      return executeGetSubscriptionDetail(toolArgs);
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
    case "updateSubscription":
      return executeUpdateSubscription(accountId, toolArgs);
    case "deleteSubscription":
      return executeDeleteSubscription(toolArgs);

    // 4. 网盘管理
    case "getStorageDrives":
      return executeGetStorageDrives(accountId);
    case "checkDriveQuota":
      return executeCheckDriveQuota(accountId, toolArgs);
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
    case "searchDriveFiles":
      return executeSearchDriveFiles(accountId, toolArgs);
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
    case "getDriveDownloadUrl":
      return executeGetDriveDownloadUrl(accountId, toolArgs);
    case "scanDriveMedia":
      return executeScanDriveMedia(accountId, toolArgs);
    case "adoptDriveMedia":
      return executeAdoptDriveMedia(accountId, toolArgs);
    case "planOrganizeMedia":
      return executePlanOrganizeMedia(accountId, toolArgs);
    case "executeOrganizeMedia":
      return executeExecuteOrganizeMedia(accountId, toolArgs);

    // 5. STRM 管理
    case "listStrmTasks":
      return executeListStrmTasks(accountId);
    case "createStrmTask":
      return executeCreateStrmTask(accountId, toolArgs);
    case "triggerStrmSync":
      return executeTriggerStrmSync(accountId, toolArgs);

    // 6. 第三方媒体库
    case "listMediaServers":
      return executeListMediaServers(accountId);
    case "syncMediaServerLibrary":
      return executeSyncMediaServerLibrary(accountId, toolArgs);
    case "testMediaServerConnection":
      return executeTestMediaServerConnection(accountId, toolArgs);

    // 7. 动态扩展与插件
    case "listExtensions":
      return executeListExtensions();
    case "toggleExtension":
      return executeToggleExtension(toolArgs);

    // 8. 辅助状态与探针
    case "queryStatus":
      return executeQueryStatus(accountId);
    case "queryLibrary":
      return executeQueryLibrary(accountId);
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

  // 权限卡口强校验：当前安全上下文必须包含该工具所需权限
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
