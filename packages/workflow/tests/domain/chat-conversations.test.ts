import { describe, expect, it } from "vitest";
import {
  groupConversationsByDate,
  heuristicConversationTitle,
  type ChatConversationSummary,
} from "../../src/chat-conversations.js";
import { InMemoryWorkflowRepository } from "../../src/repository.js";
import { createSqliteWorkflowRepository } from "../../src/sqlite.js";

describe("heuristicConversationTitle", () => {
  it("strips common user prompt prefixes and trailing punctuation", () => {
    expect(heuristicConversationTitle("帮我搜 孤独摇滚")).toBe("孤独摇滚");
    expect(heuristicConversationTitle("请问有什么好看的科幻片？")).toBe("好看的科幻片");
    expect(heuristicConversationTitle("我想看 葬送的芙莉莲！")).toBe("葬送的芙莉莲");
    expect(heuristicConversationTitle("查找 间谍过家家")).toBe("间谍过家家");
    expect(heuristicConversationTitle("推荐一下 赛博朋克 边缘行者")).toBe("赛博朋克 边缘行者");
  });

  it("truncates long prompt with ellipsis", () => {
    const longPrompt = "这是一段非常非常长的提问关于流浪地球2和星际穿越的深度细节对比分析";
    const title = heuristicConversationTitle(longPrompt, 15);
    expect(title.length).toBeLessThanOrEqual(18); // 15 + 3 ("...")
    expect(title.endsWith("...")).toBe(true);
  });

  it("falls back to default title for empty or whitespace prompts", () => {
    expect(heuristicConversationTitle("")).toBe("新对话");
    expect(heuristicConversationTitle("   ")).toBe("新对话");
    expect(heuristicConversationTitle("？! ，")).toBe("新对话");
  });
});

describe("groupConversationsByDate", () => {
  it("groups conversations into temporal buckets correctly", () => {
    const now = new Date("2026-10-29T12:00:00.000Z");
    const convs: ChatConversationSummary[] = [
      {
        id: "c1",
        accountId: "a1",
        title: "Today Conv",
        messageCount: 1,
        createdAt: "2026-10-29T10:00:00.000Z",
        updatedAt: "2026-10-29T10:00:00.000Z",
      },
      {
        id: "c2",
        accountId: "a1",
        title: "Yesterday Conv",
        messageCount: 2,
        createdAt: "2026-10-28T15:00:00.000Z",
        updatedAt: "2026-10-28T15:00:00.000Z",
      },
      {
        id: "c3",
        accountId: "a1",
        title: "Past 7 Days Conv",
        messageCount: 3,
        createdAt: "2026-10-25T08:00:00.000Z",
        updatedAt: "2026-10-25T08:00:00.000Z",
      },
      {
        id: "c4",
        accountId: "a1",
        title: "Older Conv",
        messageCount: 4,
        createdAt: "2026-09-01T08:00:00.000Z",
        updatedAt: "2026-09-01T08:00:00.000Z",
      },
    ];

    const grouped = groupConversationsByDate(convs, now);
    expect(grouped.length).toBe(4);
    expect(grouped[0]?.key).toBe("today");
    expect(grouped[0]?.items[0]?.id).toBe("c1");
    expect(grouped[1]?.key).toBe("yesterday");
    expect(grouped[1]?.items[0]?.id).toBe("c2");
    expect(grouped[2]?.key).toBe("past7Days");
    expect(grouped[2]?.items[0]?.id).toBe("c3");
    expect(grouped[3]?.key).toBe("older");
    expect(grouped[3]?.items[0]?.id).toBe("c4");
  });
});

describe("ChatConversationStore (InMemory)", () => {
  it("creates, retrieves, updates, and deletes conversations with message persistence", async () => {
    const repo = new InMemoryWorkflowRepository();
    const accountA = "acct_a";
    const accountB = "acct_b";

    // 1. Create conversation
    const conv = await repo.createConversation({
      accountId: accountA,
      title: "影视检索：间谍过家家",
      storageId: "storage_1",
      now: "2026-10-29T10:00:00.000Z",
    });
    expect(conv.id).toBeDefined();
    expect(conv.title).toBe("影视检索：间谍过家家");
    expect(conv.messageCount).toBe(0);

    // 2. Multi-account isolation
    const listA = await repo.listConversations({ accountId: accountA });
    expect(listA.length).toBe(1);
    const listB = await repo.listConversations({ accountId: accountB });
    expect(listB.length).toBe(0);
    const getB = await repo.getConversation({ accountId: accountB, id: conv.id });
    expect(getB).toBeNull();

    // 3. Save messages
    await repo.saveMessage({
      id: "msg_1",
      conversationId: conv.id,
      accountId: accountA,
      role: "user",
      content: "搜 间谍过家家",
      createdAt: "2026-10-29T10:01:00.000Z",
    });

    await repo.saveMessage({
      id: "msg_2",
      conversationId: conv.id,
      accountId: accountA,
      role: "assistant",
      content: "找到了以下资源：",
      thinking: "检索 TMDB 匹配条目",
      toolsUsed: [{ id: "t1", toolName: "searchMedia", status: "success" }],
      actionCard: { kind: "media_list", query: "间谍过家家", items: [] },
      createdAt: "2026-10-29T10:02:00.000Z",
    });

    const messages = await repo.listMessages({ accountId: accountA, conversationId: conv.id });
    expect(messages.length).toBe(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.thinking).toBe("检索 TMDB 匹配条目");
    expect(messages[1]?.actionCard).toMatchObject({ kind: "media_list" });

    // 4. Update conversation (rename)
    const updated = await repo.updateConversation({
      accountId: accountA,
      id: conv.id,
      title: "重命名后标题",
      updatedAt: "2026-10-29T10:05:00.000Z",
    });
    expect(updated?.title).toBe("重命名后标题");

    // 5. Delete conversation
    const deleted = await repo.deleteConversation({ accountId: accountA, id: conv.id });
    expect(deleted).toBe(true);
    const remainingConvs = await repo.listConversations({ accountId: accountA });
    expect(remainingConvs.length).toBe(0);
    const remainingMsgs = await repo.listMessages({ accountId: accountA, conversationId: conv.id });
    expect(remainingMsgs.length).toBe(0);
  });
});

describe("ChatConversationStore (SQLite)", () => {
  it("persists conversations and messages into sqlite database and cascades deletion", async () => {
    const repo = createSqliteWorkflowRepository({ path: ":memory:" });
    const accountA = "acct_test";

    const conv = await repo.createConversation({
      accountId: accountA,
      title: "SQLite 测试会话",
      storageId: "pan115_root",
      now: "2026-10-29T12:00:00.000Z",
    });

    expect(conv.id).toBeDefined();

    await repo.saveMessage({
      id: "msg_sqlite_1",
      conversationId: conv.id,
      accountId: accountA,
      role: "user",
      content: "查看当前任务进度",
      createdAt: "2026-10-29T12:00:05.000Z",
    });

    await repo.saveMessage({
      id: "msg_sqlite_2",
      conversationId: conv.id,
      accountId: accountA,
      role: "assistant",
      content: "当前正在执行 1 个任务",
      toolsUsed: [{ toolName: "queryStatus", status: "success" }],
      createdAt: "2026-10-29T12:00:08.000Z",
    });

    const msgs = await repo.listMessages({ accountId: accountA, conversationId: conv.id });
    expect(msgs.length).toBe(2);
    expect(msgs[1]?.content).toBe("当前正在执行 1 个任务");
    expect(msgs[1]?.toolsUsed).toEqual([{ toolName: "queryStatus", status: "success" }]);

    const convList = await repo.listConversations({ accountId: accountA });
    expect(convList.length).toBe(1);
    expect(convList[0]?.messageCount).toBe(2);
    expect(convList[0]?.updatedAt).toBe("2026-10-29T12:00:08.000Z");

    const deleted = await repo.deleteConversation({ accountId: accountA, id: conv.id });
    expect(deleted).toBe(true);

    const afterList = await repo.listConversations({ accountId: accountA });
    expect(afterList.length).toBe(0);
    const afterMsgs = await repo.listMessages({ accountId: accountA, conversationId: conv.id });
    expect(afterMsgs.length).toBe(0);
  });
});
