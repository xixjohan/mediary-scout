"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ChatConversationSummary } from "../../../lib/chat-types";
import { ChatSidebar, type ChatSidebarProps } from "./chat-sidebar";
import { ChatPanel } from "./chat-panel";

export interface ChatWorkspaceProps {
  storageId?: string | undefined;
  initialConversationId?: string | undefined;
}

type ChatHistoryLayerProps = Omit<
  ChatSidebarProps,
  | "collapsed"
  | "collapseLabel"
  | "hasLoadError"
  | "isLoading"
  | "onRetryLoad"
  | "onToggleCollapse"
> & {
  hasLoadError: boolean;
  isLoading: boolean;
  isCompactLayout: boolean;
  isOpen: boolean;
  isSidebarCollapsed: boolean;
  historyToggleRef: RefObject<HTMLButtonElement | null>;
  onRetryLoad: () => void;
  onClose: () => void;
  onToggleCollapse: () => void;
};

function useHistoryDrawerFocus(
  isCompactLayout: boolean,
  isOpen: boolean,
  drawerRef: RefObject<HTMLDivElement | null>,
  historyToggleRef: RefObject<HTMLButtonElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    if (!isCompactLayout || !isOpen) return;

    const drawer = drawerRef.current;
    const trigger = historyToggleRef.current;
    const focusableSelector =
      'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const getFocusableElements = () =>
      Array.from(drawer?.querySelectorAll<HTMLElement>(focusableSelector) ?? []).filter(
        (element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true",
      );

    drawer?.querySelector<HTMLElement>(".chat-sidebar-new-btn")?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") return;
      const focusableElements = getFocusableElements();
      const first = focusableElements[0];
      const last = focusableElements.at(-1);
      if (!first || !last) {
        event.preventDefault();
        drawer?.focus();
      } else if (!drawer?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === drawer)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      requestAnimationFrame(() => {
        if (trigger?.isConnected && trigger.getClientRects().length > 0) trigger.focus();
      });
    };
  }, [drawerRef, historyToggleRef, isCompactLayout, isOpen, onClose]);
}

function ChatHistoryLayer({
  conversations,
  activeId,
  onSelect,
  onNewChat,
  onDelete,
  onRename,
  isLoading,
  hasLoadError,
  onRetryLoad,
  isCompactLayout,
  isOpen,
  isSidebarCollapsed,
  historyToggleRef,
  onClose,
  onToggleCollapse,
}: ChatHistoryLayerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  useHistoryDrawerFocus(isCompactLayout, isOpen, drawerRef, historyToggleRef, onClose);

  return (
    <div
      id="chat-history-sidebar"
      ref={drawerRef}
      className={`chat-sidebar-layer${isCompactLayout && isOpen ? " is-open" : ""}`}
      role={isCompactLayout ? "dialog" : undefined}
      aria-label={isCompactLayout ? "会话历史" : undefined}
      aria-modal={isCompactLayout && isOpen ? true : undefined}
      aria-hidden={isCompactLayout && !isOpen ? true : undefined}
      inert={isCompactLayout && !isOpen}
      tabIndex={isCompactLayout && isOpen ? -1 : undefined}
    >
      {isCompactLayout ? (
        <div className="chat-sidebar-backdrop" aria-hidden="true" onClick={onClose} />
      ) : null}
      <ChatSidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={onSelect}
        onNewChat={onNewChat}
        onDelete={onDelete}
        onRename={onRename}
        collapsed={!isCompactLayout && isSidebarCollapsed}
        isLoading={isLoading}
        hasLoadError={hasLoadError}
        onRetryLoad={onRetryLoad}
        collapseLabel={isCompactLayout ? "关闭会话历史" : "收起会话侧栏"}
        onToggleCollapse={onToggleCollapse}
      />
    </div>
  );
}

export function ChatWorkspace({
  storageId,
  initialConversationId,
}: ChatWorkspaceProps) {
  const [conversations, setConversations] = useState<ChatConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(initialConversationId || null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [isHistoryDrawerOpen, setIsHistoryDrawerOpen] = useState(false);
  const [isLoadingConversations, setIsLoadingConversations] = useState(true);
  const [conversationsError, setConversationsError] = useState(false);
  const historyToggleRef = useRef<HTMLButtonElement>(null);

  // 加载会话列表
  const refreshConversations = useCallback(async () => {
    setIsLoadingConversations(true);
    setConversationsError(false);
    try {
      const res = await fetch("/api/chat/conversations");
      if (!res.ok) throw new Error("加载会话列表失败");
      const data: unknown = await res.json();
      if (!Array.isArray(data)) throw new Error("会话列表格式无效");
      setConversations(data as ChatConversationSummary[]);
    } catch {
      setConversationsError(true);
    } finally {
      setIsLoadingConversations(false);
    }
  }, []);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1199px)");
    const syncLayout = () => setIsCompactLayout(media.matches);
    syncLayout();
    media.addEventListener("change", syncLayout);
    return () => media.removeEventListener("change", syncLayout);
  }, []);

  const closeHistoryDrawer = useCallback(() => {
    setIsHistoryDrawerOpen(false);
  }, []);

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
      closeHistoryDrawer();
    },
    [closeHistoryDrawer, updateUrlParam],
  );

  const handleNewChat = useCallback(() => {
    setActiveId(null);
    updateUrlParam(null);
    closeHistoryDrawer();
  }, [closeHistoryDrawer, updateUrlParam]);

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
  const toggleHistory = useCallback(() => {
    if (isCompactLayout) {
      setIsHistoryDrawerOpen(true);
      return;
    }
    setIsCollapsed(false);
  }, [isCompactLayout]);

  const toggleSidebarCollapse = useCallback(() => {
    if (isCompactLayout) {
      closeHistoryDrawer();
      return;
    }
    setIsCollapsed(true);
  }, [closeHistoryDrawer, isCompactLayout]);

  return (
    <div className="chat-workspace-layout">
      <ChatHistoryLayer
        conversations={conversations}
        activeId={activeId}
        onSelect={handleSelect}
        onNewChat={handleNewChat}
        onDelete={handleDelete}
        onRename={handleRename}
        isLoading={isLoadingConversations}
        hasLoadError={conversationsError}
        onRetryLoad={() => void refreshConversations()}
        isCompactLayout={isCompactLayout}
        isOpen={isHistoryDrawerOpen}
        isSidebarCollapsed={isCollapsed}
        historyToggleRef={historyToggleRef}
        onClose={closeHistoryDrawer}
        onToggleCollapse={toggleSidebarCollapse}
      />
      <ChatPanel
        storageId={storageId}
        conversationId={activeId}
        conversationTitle={activeConv?.title}
        onTurnCompleted={handleTurnCompleted}
        isSidebarCollapsed={isCollapsed}
        isHistoryDrawerOpen={isHistoryDrawerOpen}
        isCompactLayout={isCompactLayout}
        historyToggleRef={historyToggleRef}
        onToggleSidebar={toggleHistory}
      />
    </div>
  );
}
