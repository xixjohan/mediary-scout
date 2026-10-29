"use client";

import { useCallback, useEffect, useState } from "react";
import type { ChatConversationSummary } from "../lib/chat-types";
import { ChatSidebar } from "./chat-sidebar";
import { ChatPanel } from "./chat-panel";

export interface ChatWorkspaceProps {
  storageId?: string | undefined;
  initialConversationId?: string | undefined;
}

export function ChatWorkspace({
  storageId,
  initialConversationId,
}: ChatWorkspaceProps) {
  const [conversations, setConversations] = useState<ChatConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(initialConversationId || null);
  const [isCollapsed, setIsCollapsed] = useState(false);

  // 加载会话列表
  const refreshConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/conversations");
      if (res.ok) {
        const data = (await res.json()) as ChatConversationSummary[];
        setConversations(data);
      }
    } catch {
      // 容错降级
    }
  }, []);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  // 同步 URL 参数（不引发 Next.js 全页刷新）
  const updateUrlParam = useCallback((convId: string | null) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (convId) {
      url.searchParams.set("c", convId);
    } else {
      url.searchParams.delete("c");
    }
    window.history.replaceState(null, "", url.toString());
  }, []);

  const handleSelect = useCallback(
    (id: string | null) => {
      setActiveId(id);
      updateUrlParam(id);
    },
    [updateUrlParam],
  );

  const handleNewChat = useCallback(() => {
    setActiveId(null);
    updateUrlParam(null);
  }, [updateUrlParam]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/chat/conversations/${id}`, { method: "DELETE" });
        if (res.ok) {
          setConversations((prev) => prev.filter((c) => c.id !== id));
          if (activeId === id) {
            handleNewChat();
          }
        }
      } catch {
        // 网络异常
      }
    },
    [activeId, handleNewChat],
  );

  const handleRename = useCallback(
    async (id: string, newTitle: string) => {
      try {
        const res = await fetch(`/api/chat/conversations/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: newTitle }),
        });
        if (res.ok) {
          const updated = (await res.json()) as ChatConversationSummary;
          setConversations((prev) =>
            prev.map((c) => (c.id === id ? { ...c, title: updated.title } : c)),
          );
        }
      } catch {
        // 网络异常
      }
    },
    [],
  );

  const handleTurnCompleted = useCallback(
    (convId: string) => {
      if (activeId !== convId) {
        setActiveId(convId);
        updateUrlParam(convId);
      }
      void refreshConversations();
    },
    [activeId, refreshConversations, updateUrlParam],
  );

  const activeConv = conversations.find((c) => c.id === activeId);

  return (
    <div className="chat-workspace-layout">
      <ChatSidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={handleSelect}
        onNewChat={handleNewChat}
        onDelete={handleDelete}
        onRename={handleRename}
        collapsed={isCollapsed}
        onToggleCollapse={() => setIsCollapsed(true)}
      />
      <ChatPanel
        storageId={storageId}
        conversationId={activeId}
        conversationTitle={activeConv?.title}
        onTurnCompleted={handleTurnCompleted}
        isSidebarCollapsed={isCollapsed}
        onToggleSidebar={() => setIsCollapsed(false)}
      />
    </div>
  );
}
