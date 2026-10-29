import { z } from "zod";
import { generateText, stepCountIs } from "ai";
import {
  getWorkflowRepository,
  getActiveWorkspaceScope,
  getAccountScopedSettings,
} from "./workflow-runtime";
import { getActivityView } from "./activity-view";
import { executeDiscoverMedia } from "./chat-discover";

/**
 * 智能对话助理服务（Chat Agent Service）
 *
 * 架构模式：
 *   1. 适配器模式（Adapter Pattern）：统一封装 TMDB、网盘资源检索、整理、任务进度与订阅库；
 *   2. 状态机与人机回环（FSM & Human-in-the-Loop）：高危入库/整理生成行动卡片，由用户交互确认；
 *   3. 策略模式（Strategy Pattern）：LLM Function Calling 优先，离线/无 Key 时回落至确定性意图规则。
 */

export type {
  ActionCardMediaItem,
  ActionCardCandidateItem,
  ActionCardActiveRunItem,
  ActionCardLibraryItem,
  ActionCardPayload,
  ChatTurnInput,
  ChatTurnResult,
  ToolCallItem,
} from "./chat-types";
import type {
  ActionCardPayload,
  ActionCardMediaItem,
  ActionCardActiveRunItem,
  ActionCardLibraryItem,
  ChatTurnInput,
  ChatTurnResult,
  ToolCallItem,
} from "./chat-types";

/** 意图分类检测（策略模式的纯规则分支） */
export type DeterministicIntent =
  | { type: "search_media"; query: string }
  | {
      type: "discover_media";
      year?: number | undefined;
      genre?: string | undefined;
      mediaType?: "movie" | "tv" | undefined;
    }
  | { type: "query_status" }
  | { type: "query_library" }
  | { type: "help" };

function tryParseDiscoverIntent(trimmed: string): DeterministicIntent | null {
  const isDiscover =
    /(?:推荐|发现|盘点|有什么|有哪些|好评|高分).*(?:电影|剧集|片|科幻|动作|动画|喜剧|悬疑)/i.test(trimmed) ||
    /\b(?:19\d\d|20\d\d)\b.*(?:电影|剧集|片|科幻|动作|动画|喜剧|悬疑)/i.test(trimmed);

  if (!isDiscover) return null;

  const yearMatch = /\b(19\d\d|20\d\d)\b/.exec(trimmed);
  const year = yearMatch ? Number(yearMatch[1]) : undefined;
  const isTv = /(?:剧集|电视剧|美剧|韩剧|日剧|国剧|剧)/.test(trimmed);
  let genre: string | undefined;
  const commonGenres = [
    "科幻",
    "动作",
    "动画",
    "喜剧",
    "悬疑",
    "惊悚",
    "恐怖",
    "奇幻",
    "冒险",
    "剧情",
    "战争",
    "犯罪",
    "纪录片",
  ];
  for (const g of commonGenres) {
    if (trimmed.includes(g)) {
      genre = g;
      break;
    }
  }

  return {
    type: "discover_media",
    year,
    genre,
    mediaType: isTv ? "tv" : "movie",
  };
}

export function parseDeterministicIntent(text: string): DeterministicIntent {
  const trimmed = text.trim();
  if (!trimmed) return { type: "help" };

  // 1. 查询进度 / 活动
  if (
    /^(进度|状态|任务|正在|在干嘛|下载进度|活动)$/i.test(trimmed) ||
    /(下载好了吗|进行中|运行状态|在干嘛|任务进度|有什么任务)/i.test(trimmed)
  ) {
    return { type: "query_status" };
  }

  // 2. 查询订阅库
  if (/^(在追|订阅|我的订阅|追更|看什么|库里有什么)$/i.test(trimmed) || /.*(我追了哪些|订阅列表).*/i.test(trimmed)) {
    return { type: "query_library" };
  }

  // 3. 探索 / 推荐发现
  const discover = tryParseDiscoverIntent(trimmed);
  if (discover) return discover;

  // 4. 搜索影片
  const searchMatch = /^(?:搜|找|想看|查询|检索|搜索)\s*(.+)$/i.exec(trimmed);
  if (searchMatch?.[1]) {
    return { type: "search_media", query: searchMatch[1].trim() };
  }

  // 5. 纯片名输入（如「繁花」、「孤独摇滚」）
  if (trimmed.length >= 2 && trimmed.length <= 30 && !/[?？!！。，]/.test(trimmed)) {
    return { type: "search_media", query: trimmed };
  }

  return { type: "help" };
}

/** 执行媒体库搜索 Tool */
export async function executeSearchMedia(
  query: string,
  storageId?: string,
): Promise<{ reply: string; actionCard?: ActionCardPayload | undefined; suggestedPrompts: string[] }> {
  try {
    const { getSearchView } = await import("./search-page");
    const view = await getSearchView(query, storageId);
    if (view.state === "empty" || view.candidates.length === 0) {
      return {
        reply: `在媒体库中未找到与「${query}」相关的影视。你可以尝试换一个更准确的片名或原名。`,
        suggestedPrompts: ["搜 孤独摇滚", "搜 葬送的芙莉莲", "查看当前任务进度"],
      };
    }

    const items: ActionCardMediaItem[] = view.candidates.slice(0, 4).map((c) => ({
      tmdbId: c.tmdbId,
      title: c.title,
      year: c.year,
      mediaType: c.mediaType,
      posterPath: c.posterPath ?? undefined,
      overview: c.overview ?? undefined,
    }));

    const top = items[0]!;
    return {
      reply: `为你找到了 ${view.candidates.length} 部与「${query}」相关的影片，点击卡片可查看详情或进入资源检索：`,
      actionCard: {
        kind: "media_list",
        query,
        items,
      },
      suggestedPrompts: [
        `查看《${top.title}》详情`,
        `搜《${top.title}》的4K资源`,
        "查看当前任务进度",
      ],
    };
  } catch (error) {
    return {
      reply: `搜索「${query}」时出错：${error instanceof Error ? error.message : String(error)}`,
      suggestedPrompts: ["重试搜索", "查看当前任务进度"],
    };
  }
}

/** 执行活动状态查询 Tool */
export async function executeQueryStatus(
  accountId: string,
  storageId?: string,
): Promise<{ reply: string; actionCard?: ActionCardPayload | undefined; suggestedPrompts: string[] }> {
  try {
    const repository = getWorkflowRepository();
    const view = await getActivityView({ repository, accountId, connectedStorageId: storageId ?? null });
    const activeRuns: ActionCardActiveRunItem[] = view.active.map((r) => ({
      id: r.runId,
      title: r.title,
      phase: r.progress?.activity || (r.status === "running" ? "正在执行" : "排队中"),
      progress: r.progress?.percent ?? undefined,
    }));

    if (activeRuns.length === 0) {
      return {
        reply: "目前后台没有正在执行的获取或整理任务。所有队列均已处理完毕。",
        suggestedPrompts: ["我追了哪些剧", "搜 孤独摇滚", "整理网盘目录"],
      };
    }

    return {
      reply: `当前有 ${activeRuns.length} 个任务正在处理中：`,
      actionCard: {
        kind: "activity_status",
        activeRuns,
      },
      suggestedPrompts: ["刷新任务状态", "查看订阅列表"],
    };
  } catch (error) {
    return {
      reply: `查询任务状态时出错：${error instanceof Error ? error.message : String(error)}`,
      suggestedPrompts: ["重试", "搜 孤独摇滚"],
    };
  }
}

/** 执行在追订阅库查询 Tool */
export async function executeQueryLibrary(
  accountId: string,
  storageId?: string,
): Promise<{ reply: string; actionCard?: ActionCardPayload | undefined; suggestedPrompts: string[] }> {
  try {
    const repository = getWorkflowRepository();
    const scope = await getActiveWorkspaceScope(storageId);
    const trackedSeasons = await repository.listTrackedSeasonStates(scope);

    if (trackedSeasons.length === 0) {
      return {
        reply: "你的订阅库目前还是空的。可以在搜索页搜索喜欢的影片并加入追踪。",
        suggestedPrompts: ["搜 葬送的芙莉莲", "搜 孤独摇滚", "查看任务进度"],
      };
    }

    // 聚合影片
    const map = new Map<number, ActionCardLibraryItem>();
    for (const s of trackedSeasons) {
      if (!map.has(s.title.tmdbId)) {
        map.set(s.title.tmdbId, {
          tmdbId: s.title.tmdbId,
          title: s.title.title,
          type: s.title.type,
          status: s.season.status,
        });
      }
    }

    const items = Array.from(map.values()).slice(0, 6);
    return {
      reply: `你当前在追 ${map.size} 部作品：`,
      actionCard: {
        kind: "library_summary",
        trackedCount: map.size,
        items,
      },
      suggestedPrompts: ["查看任务进度", `去看看《${items[0]?.title ?? "最新剧集"}》`],
    };
  } catch (error) {
    return {
      reply: `查询订阅库时出错：${error instanceof Error ? error.message : String(error)}`,
      suggestedPrompts: ["重试", "搜 孤独摇滚"],
    };
  }
}

/** 生成默认问候与建议 */
export function executeHelp(): ChatTurnResult {
  return {
    reply:
      "你好！我是巡影智能助理。我可以帮你完成影视检索、状态追踪、网盘转存入库以及目录整理等工作。\n\n你可以试着对我说：\n- 「帮我搜一下《孤独摇滚》」\n- 「查看当前下载进度」\n- 「我订阅了哪些影片」\n- 「整理刚才下载的剧集」",
    suggestedPrompts: ["搜 孤独摇滚", "搜 葬送的芙莉莲", "查看当前任务进度", "我追了哪些剧"],
  };
}

function buildChatSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    `你是一个专业的影视媒体管理助手（巡影 Mediary Scout）。当前系统现实日期：${today}。`,
    "回答要严谨、客观、专业，并严格遵循以下真实性与工具调度门禁：",
    "1. 【工具强制调用】：",
    "   - 当用户要求发现、盘点、推荐某年份、某种题材（如科幻、动作、动画等）或评分的影视时，严禁使用模型自身可能过时的预训练记忆编造，必须调用 `discoverMedia` 工具查询 TMDB 真实数据库。",
    "   - 当用户检索具体片名时，调用 `searchMedia` 工具。",
    "   - 当用户查询后台下载、整理、运行状态时，调用 `queryStatus` 工具。",
    "   - 当用户查询已追踪订阅库时，调用 `queryLibrary` 工具。",
    "2. 【时态与评分防幻觉门禁（Truth-Guarding）】：",
    `   - 现实时间为 ${today}。凡尚未正式公映或未来年份（如 2026 年）的电影，在现实数据库中暂无真实公映评分，状态应明确标为“待公映/定档中”，评分标为“未上映，暂无公映评分”，严禁凭空捏造未公映影片的虚假评分、虚假好评或观众口碑！`,
    "   - 若某年份（如 2026 年）上映作品较少，应如实说明受全球影视制作周期和排期推迟影响，许多原本预计 2026 年上映的大制作项目已顺延至 2027 年及以后。",
  ].join("\n");
}

export function extractThinkingAndCleanReply(text: string): {
  thinking?: string | undefined;
  cleanReply: string;
} {
  const match = /<think>([\s\S]*?)<\/think>/i.exec(text);
  if (!match?.[1]) {
    return { cleanReply: text };
  }
  const thinking = match[1].trim();
  const cleanReply = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  return { thinking: thinking || undefined, cleanReply };
}

export function summarizeToolResult(toolName: string, res: unknown): string {
  const card = (res as { actionCard?: ActionCardPayload })?.actionCard;
  if (!card) return "执行完成";
  if (card.kind === "media_list") {
    return `找到 ${card.items.length} 部作品`;
  }
  if (card.kind === "activity_status") {
    return `发现 ${card.activeRuns.length} 个进行中任务`;
  }
  if (card.kind === "library_summary") {
    return `订阅库共 ${card.trackedCount} 部`;
  }
  if (card.kind === "resource_list") {
    return `检索到 ${card.candidates.length} 条网盘候选`;
  }
  return "执行完成";
}

function collectStepToolsAndCard(steps: unknown[]): {
  toolsUsed: ToolCallItem[];
  matchedCard?: ActionCardPayload | undefined;
} {
  const toolsUsed: ToolCallItem[] = [];
  let matchedCard: ActionCardPayload | undefined;

  for (const rawStep of steps) {
    const step = rawStep as {
      toolCalls?: Array<{ toolCallId: string; toolName: string; args?: unknown; input?: unknown }> | undefined;
      toolResults?: Array<{ toolCallId: string; result?: unknown; output?: unknown }> | undefined;
    };
    for (const call of step.toolCalls ?? []) {
      const tr = (step.toolResults ?? []).find((r) => r.toolCallId === call.toolCallId);
      const res = tr ? (tr.output ?? tr.result) : undefined;
      const callArgs = (call.args ?? call.input ?? {}) as Record<string, unknown>;
      toolsUsed.push({
        id: call.toolCallId,
        toolName: call.toolName,
        args: callArgs,
        status: "success",
        summary: summarizeToolResult(call.toolName, res),
      });
    }
    for (const tr of step.toolResults ?? []) {
      const res = (tr.output ?? tr.result) as { actionCard?: ActionCardPayload } | undefined;
      if (res?.actionCard) {
        matchedCard = res.actionCard;
        break;
      }
    }
  }

  return { toolsUsed, matchedCard };
}

async function tryLlmChatTurn(input: ChatTurnInput): Promise<ChatTurnResult | null> {
  try {
    if (process.env.MEDIA_TRACK_AGENT_ADAPTER !== "vercel-ai") {
      return null;
    }
    const { getAgentModel } = await import("./workflow-runtime");
    const settings = getAccountScopedSettings(input.accountId);
    const { model } = await getAgentModel(settings);
    if (!model) return null;

    const llmResult = await generateText({
      model,
      system: buildChatSystemPrompt(),
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      tools: {
        discoverMedia: {
          description:
            "在 TMDB 实时数据库中按年份、分类类型（如科幻、动作、动画等）发现、推荐和筛选电影或剧集。当用户要求推荐某年份、某种题材、某种评分的影视时必须调用本工具。",
          inputSchema: z.object({
            genre: z.string().optional().describe("题材分类，例如：科幻、动作、动画、喜剧、悬疑、剧情、恐怖等"),
            year: z.number().int().optional().describe("上映年份，例如：2026、2025、2024 等"),
            type: z.enum(["movie", "tv"]).optional().describe("媒体类型：movie（电影，默认）或 tv（剧集）"),
            sortBy: z
              .enum(["popularity", "rating", "release_date"])
              .optional()
              .describe("排序方式：popularity（热门，默认）、rating（评分）、release_date（上映日期）"),
          }),
          execute: async (params) => executeDiscoverMedia(params),
        },
        searchMedia: {
          description: "在 TMDB 检索电影或剧集基本信息",
          inputSchema: z.object({ query: z.string().describe("影片名称或关键词") }),
          execute: async ({ query }) => executeSearchMedia(query, input.storageId),
        },
        queryStatus: {
          description: "查询当前后台正在进行的获取、转存、整理等任务进度",
          inputSchema: z.object({}),
          execute: async () => executeQueryStatus(input.accountId, input.storageId),
        },
        queryLibrary: {
          description: "查询当前用户已订阅和追踪的影视列表",
          inputSchema: z.object({}),
          execute: async () => executeQueryLibrary(input.accountId, input.storageId),
        },
      },
      stopWhen: [stepCountIs(3)],
    });

    const { toolsUsed, matchedCard } = collectStepToolsAndCard(llmResult.steps);
    const { thinking, cleanReply } = extractThinkingAndCleanReply(llmResult.text);
    if (!cleanReply.trim() && !thinking) return null;

    return {
      reply: cleanReply || "思考完毕。",
      thinking,
      toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
      actionCard: matchedCard,
      suggestedPrompts: ["查看当前任务进度", "我追了哪些剧", "搜 孤独摇滚"],
    };
  } catch (llmError) {
    console.warn("[ChatAgentService] LLM turn error, falling back to deterministic intent:", llmError);
    return null;
  }
}

async function dispatchDeterministicIntent(
  intent: DeterministicIntent,
  accountId: string,
  storageId?: string,
): Promise<ChatTurnResult> {
  let res: ChatTurnResult;
  let toolName = "help";
  let args: Record<string, unknown> = {};

  switch (intent.type) {
    case "discover_media":
      toolName = "discoverMedia";
      args = { year: intent.year, genre: intent.genre, type: intent.mediaType };
      res = await executeDiscoverMedia({
        year: intent.year,
        genre: intent.genre,
        type: intent.mediaType,
      });
      break;
    case "search_media":
      toolName = "searchMedia";
      args = { query: intent.query };
      res = await executeSearchMedia(intent.query, storageId);
      break;
    case "query_status":
      toolName = "queryStatus";
      res = await executeQueryStatus(accountId, storageId);
      break;
    case "query_library":
      toolName = "queryLibrary";
      res = await executeQueryLibrary(accountId, storageId);
      break;
    case "help":
    default:
      return executeHelp();
  }

  const summary = summarizeToolResult(toolName, res);
  return {
    ...res,
    toolsUsed: [
      {
        id: `det-${Date.now()}`,
        toolName,
        args,
        status: "success",
        summary,
      },
    ],
  };
}

/**
 * 智能对话单轮调度核心入口。
 * 优先采用 LLM Function Calling，若模型不可用或报错则无缝平滑回落至规则意图引擎。
 */
export async function handleChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
  const lastUserMsg = [...input.messages].reverse().find((m) => m.role === "user");
  const userText = lastUserMsg?.content.trim() ?? "";

  if (!userText) {
    return executeHelp();
  }

  const llmRes = await tryLlmChatTurn(input);
  if (llmRes) return llmRes;

  const intent = parseDeterministicIntent(userText);
  return dispatchDeterministicIntent(intent, input.accountId, input.storageId);
}
