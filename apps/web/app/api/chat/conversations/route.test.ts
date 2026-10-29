import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { InMemoryWorkflowRepository } from "@media-track/workflow";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});

const mockRepo = new InMemoryWorkflowRepository();

vi.mock("../../../../lib/auth-chain", () => ({
  requireApiAccount: vi.fn().mockResolvedValue("acct_test"),
}));

vi.mock("../../../../lib/workflow-runtime", () => ({
  getWorkflowRepository: vi.fn(() => mockRepo),
}));

import { GET as listConversations, POST as createConversation } from "./route";
import {
  GET as getConversation,
  PATCH as renameConversation,
  DELETE as deleteConversation,
} from "./[id]/route";

describe("/api/chat/conversations routes", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const existing = await mockRepo.listConversations({ accountId: "acct_test" });
    for (const c of existing) {
      await mockRepo.deleteConversation({ accountId: "acct_test", id: c.id });
    }
  });

  it("creates a conversation via POST and lists it via GET", async () => {
    const postReq = new NextRequest("http://localhost:3000/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "我的对话测试", storageId: "pan115_root" }),
    });

    const postRes = await createConversation(postReq);
    expect(postRes.status).toBe(201);
    const created = (await postRes.json()) as { id: string; title: string; storageId: string };
    expect(created.id).toBeDefined();
    expect(created.title).toBe("我的对话测试");
    expect(created.storageId).toBe("pan115_root");

    const getReq = new NextRequest("http://localhost:3000/api/chat/conversations");
    const getRes = await listConversations(getReq);
    expect(getRes.status).toBe(200);
    const list = (await getRes.json()) as Array<{ id: string; title: string }>;
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe(created.id);
  });

  it("fetches conversation detail with messages via GET [id]", async () => {
    const conv = await mockRepo.createConversation({
      accountId: "acct_test",
      title: "检索测试",
      now: new Date().toISOString(),
    });

    await mockRepo.saveMessage({
      id: "m1",
      conversationId: conv.id,
      accountId: "acct_test",
      role: "user",
      content: "搜 间谍过家家",
      createdAt: new Date().toISOString(),
    });

    const req = new NextRequest(`http://localhost:3000/api/chat/conversations/${conv.id}`);
    const res = await getConversation(req, { params: Promise.resolve({ id: conv.id }) });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      conversation: { id: string; title: string };
      messages: Array<{ id: string; role: string; content: string }>;
    };
    expect(data.conversation.id).toBe(conv.id);
    expect(data.messages.length).toBe(1);
    expect(data.messages[0]?.content).toBe("搜 间谍过家家");
  });

  it("renames a conversation via PATCH [id]", async () => {
    const conv = await mockRepo.createConversation({
      accountId: "acct_test",
      title: "原标题",
      now: new Date().toISOString(),
    });

    const req = new NextRequest(`http://localhost:3000/api/chat/conversations/${conv.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "修改后的标题" }),
    });

    const res = await renameConversation(req, { params: Promise.resolve({ id: conv.id }) });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { title: string };
    expect(updated.title).toBe("修改后的标题");

    const fetched = await mockRepo.getConversation({ accountId: "acct_test", id: conv.id });
    expect(fetched?.title).toBe("修改后的标题");
  });

  it("deletes a conversation via DELETE [id]", async () => {
    const conv = await mockRepo.createConversation({
      accountId: "acct_test",
      title: "准备删除的会话",
      now: new Date().toISOString(),
    });

    const req = new NextRequest(`http://localhost:3000/api/chat/conversations/${conv.id}`, {
      method: "DELETE",
    });

    const res = await deleteConversation(req, { params: Promise.resolve({ id: conv.id }) });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean };
    expect(data.success).toBe(true);

    const afterList = await mockRepo.listConversations({ accountId: "acct_test" });
    expect(afterList.length).toBe(0);
  });
});
