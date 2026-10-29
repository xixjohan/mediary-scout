import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  executeHelp,
  extractThinkingAndCleanReply,
  handleChatTurn,
  parseDeterministicIntent,
  summarizeToolResult,
} from "./chat-agent-service";

describe("extractThinkingAndCleanReply — 思考链提取与清理", () => {
  it("正常提取 <think> 标签并清洗主回复文本", () => {
    const input = "<think>\n先分析用户要查的是科幻电影，年份为2026年。\n</think>\n为你找到了以下相关科幻电影：";
    const res = extractThinkingAndCleanReply(input);
    expect(res.thinking).toBe("先分析用户要查的是科幻电影，年份为2026年。");
    expect(res.cleanReply).toBe("为你找到了以下相关科幻电影：");
  });

  it("无 <think> 标签时原样返回 cleanReply", () => {
    const input = "直接回复的内容";
    const res = extractThinkingAndCleanReply(input);
    expect(res.thinking).toBeUndefined();
    expect(res.cleanReply).toBe("直接回复的内容");
  });
});

describe("summarizeToolResult — 工具执行摘要生成", () => {
  it("针对不同卡片类型生成精准中文摘要", () => {
    expect(
      summarizeToolResult("discoverMedia", {
        actionCard: { kind: "media_list", query: "2026", items: [{} as never, {} as never] },
      }),
    ).toBe("找到 2 部作品");

    expect(
      summarizeToolResult("queryStatus", {
        actionCard: { kind: "activity_status", activeRuns: [{} as never] },
      }),
    ).toBe("发现 1 个进行中任务");

    expect(
      summarizeToolResult("queryLibrary", {
        actionCard: { kind: "library_summary", trackedCount: 15, items: [] },
      }),
    ).toBe("订阅库共 15 部");
  });
});

describe("parseDeterministicIntent — 规则意图解析策略", () => {
  it("空白输入返回 help", () => {
    expect(parseDeterministicIntent("")).toEqual({ type: "help" });
    expect(parseDeterministicIntent("   ")).toEqual({ type: "help" });
  });

  it("任务/进度相关指令识别为 query_status", () => {
    expect(parseDeterministicIntent("进度")).toEqual({ type: "query_status" });
    expect(parseDeterministicIntent("任务")).toEqual({ type: "query_status" });
    expect(parseDeterministicIntent("现在在干嘛")).toEqual({ type: "query_status" });
    expect(parseDeterministicIntent("阿凡达下载好了吗")).toEqual({ type: "query_status" });
  });

  it("订阅/追更相关指令识别为 query_library", () => {
    expect(parseDeterministicIntent("在追")).toEqual({ type: "query_library" });
    expect(parseDeterministicIntent("我的订阅")).toEqual({ type: "query_library" });
    expect(parseDeterministicIntent("我追了哪些剧")).toEqual({ type: "query_library" });
  });

  it("搜/找/想看关键词识别为 search_media 并提取片名", () => {
    expect(parseDeterministicIntent("搜 孤独摇滚")).toEqual({
      type: "search_media",
      query: "孤独摇滚",
    });
    expect(parseDeterministicIntent("找 进击的巨人")).toEqual({
      type: "search_media",
      query: "进击的巨人",
    });
    expect(parseDeterministicIntent("想看 繁花")).toEqual({
      type: "search_media",
      query: "繁花",
    });
  });

  it("纯片名直接解析为 search_media", () => {
    expect(parseDeterministicIntent("孤独摇滚")).toEqual({
      type: "search_media",
      query: "孤独摇滚",
    });
  });

  it("推荐/盘点/分类年份发现识别为 discover_media", () => {
    expect(parseDeterministicIntent("推荐2026年科幻电影")).toEqual({
      type: "discover_media",
      year: 2026,
      genre: "科幻",
      mediaType: "movie",
    });

    expect(parseDeterministicIntent("盘点高分悬疑美剧")).toEqual({
      type: "discover_media",
      year: undefined,
      genre: "悬疑",
      mediaType: "tv",
    });
  });
});

describe("executeHelp — 帮助指引", () => {
  it("返回亲和的引导提示与预设 chips", () => {
    const res = executeHelp();
    expect(res.reply).toContain("巡影智能助理");
    expect(res.suggestedPrompts).toContain("搜 孤独摇滚");
    expect(res.suggestedPrompts).toContain("查看当前任务进度");
  });
});

describe("handleChatTurn — 调度流转", () => {
  it("无内容或纯问候时平滑返回帮助", async () => {
    const res = await handleChatTurn({
      messages: [{ role: "user", content: "" }],
      accountId: "acct_test",
    });
    expect(res.reply).toContain("巡影智能助理");
  });

  it("对2026年影视推荐触发防幻觉与未上映实况提醒", async () => {
    const res = await handleChatTurn({
      messages: [{ role: "user", content: "推荐2026年科幻电影" }],
      accountId: "acct_test",
    });
    expect(res.reply).toContain("现实数据门禁提醒");
    expect(res.reply).toContain("2026");
    expect(res.reply).toContain("尚未公映");
  });
});
