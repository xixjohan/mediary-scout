"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  PanelLeftOpen,
  Send,
  Sparkles,
} from "lucide-react";
import type { ActionCardPayload, ToolCallItem } from "../lib/chat-agent-service";
import { ChatMessageItem, type ChatMessage } from "./chat-cards";
import type { PersistedChatMessage } from "../lib/chat-types";

interface ServerChatResponse {
  reply: string;
  thinking?: string | undefined;
  toolsUsed?: ToolCallItem[] | undefined;
  actionCard?: ActionCardPayload | undefined;
  suggestedPrompts: string[];
  conversationId: string;
}

const INITIAL_MESSAGE: ChatMessage = {
  id: "init-1",
  role: "assistant",
  content:
    "你好！我是巡影智能助理（Mediary Copilot）。我可以协助你完成影视检索、进度查询、网盘入库以及目录整理等工作。\n\n请直接告诉我你想做什么，或者点击下方快捷指令开始：",
  timestamp: "刚刚",
};

const DEFAULT_PROMPTS = [
  "搜 孤独摇滚",
  "搜 葬送的芙莉莲",
  "查看当前任务进度",
  "我追了哪些剧",
];

export interface ChatPanelProps {
  storageId?: string | undefined;
  conversationId: string | null;
  conversationTitle?: string | undefined;
  onTurnCompleted?: (conversationId: string) => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}

function formatMsgTime(isoString?: string): string {
  if (!isoString) return "刚刚";
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return "刚刚";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "刚刚";
  }
}

export function ChatPanel({
  storageId,
  conversationId,
  conversationTitle,
  onTurnCompleted,
  isSidebarCollapsed,
  onToggleSidebar,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([INITIAL_MESSAGE]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [suggestedPrompts, setSuggestedPrompts] = useState<string[]>(DEFAULT_PROMPTS);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 1. 切换会话时加载历史记录
  useEffect(() => {
    if (!conversationId) {
      setMessages([INITIAL_MESSAGE]);
      setLoadingHistory(false);
      return;
    }

    let isSubscribed = true;
    setLoadingHistory(true);

    fetch(`/api/chat/conversations/${conversationId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("加载会话失败");
        return (await res.json()) as {
          messages: PersistedChatMessage[];
        };
      })
      .then((data) => {
        if (!isSubscribed) return;
        if (!data.messages || data.messages.length === 0) {
          setMessages([INITIAL_MESSAGE]);
        } else {
          const loaded: ChatMessage[] = data.messages.map((m) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            timestamp: formatMsgTime(m.createdAt),
            thinking: m.thinking ?? undefined,
            toolsUsed: (m.toolsUsed as ToolCallItem[]) ?? undefined,
            actionCard: (m.actionCard as ActionCardPayload) ?? undefined,
          }));
          setMessages(loaded);
        }
      })
      .catch(() => {
        if (!isSubscribed) return;
        setMessages([INITIAL_MESSAGE]);
      })
      .finally(() => {
        if (isSubscribed) setLoadingHistory(false);
      });

    return () => {
      isSubscribed = false;
    };
  }, [conversationId]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const send = useCallback(
    async (textToSend: string) => {
      const trimmed = textToSend.trim();
      if (!trimmed || busy) return;

      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: trimmed,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };

      setMessages((prev) => [...prev, userMsg]);
      setInput("");
      setBusy(true);

      try {
        const history = [...messages, userMsg].map((m) => ({
          role: m.role,
          content: m.content,
        }));

        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationId: conversationId || undefined,
            messages: history,
            storageId,
          }),
        });

        if (!response.ok) {
          throw new Error(`服务响应异常（${response.status}）`);
        }

        const data = (await response.json()) as ServerChatResponse;
        const assistantMsg: ChatMessage = {
          id: `asst-${Date.now()}`,
          role: "assistant",
          content: data.reply,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          thinking: data.thinking,
          toolsUsed: data.toolsUsed,
          actionCard: data.actionCard,
        };

        setMessages((prev) => [...prev, assistantMsg]);
        if (data.suggestedPrompts && data.suggestedPrompts.length > 0) {
          setSuggestedPrompts(data.suggestedPrompts);
        }

        if (data.conversationId && onTurnCompleted) {
          onTurnCompleted(data.conversationId);
        }
      } catch (error) {
        const errorMsg: ChatMessage = {
          id: `err-${Date.now()}`,
          role: "assistant",
          content: `网络连接异常：${error instanceof Error ? error.message : String(error)}。请稍后重试。`,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };
        setMessages((prev) => [...prev, errorMsg]);
      } finally {
        setBusy(false);
      }
    },
    [busy, conversationId, messages, onTurnCompleted, storageId],
  );

  const toggleRawMode = useCallback((msgId: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, rawMode: !m.rawMode } : m)),
    );
  }, []);

  const handleEditUserMsg = useCallback((content: string) => {
    setInput(content);
    inputRef.current?.focus();
  }, []);

  const handleRetryLast = useCallback(
    (msgIndex: number) => {
      for (let i = msgIndex - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (m && m.role === "user") {
          void send(m.content);
          return;
        }
      }
    },
    [messages, send],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  return (
    <div className="chat-container">
      <header className="chat-header">
        <div className="chat-header-left">
          {isSidebarCollapsed && onToggleSidebar ? (
            <button
              type="button"
              className="chat-sidebar-toggle-btn"
              onClick={onToggleSidebar}
              title="展开会话侧栏"
              aria-label="展开会话侧栏"
            >
              <PanelLeftOpen size={18} />
            </button>
          ) : null}

          <div className="chat-avatar-bot">
            <Bot size={20} />
          </div>
          <div>
            <h1 className="chat-title">{conversationTitle || "智能助理"}</h1>
            <p className="chat-subtitle">Mediary Copilot · 影视检索与管理</p>
          </div>
        </div>
        <div className="chat-status-pill">
          <Sparkles size={13} aria-hidden />
          <span>全能调度模式</span>
        </div>
      </header>

      <div className="chat-message-list">
        {loadingHistory ? (
          <div className="chat-loading-history">
            <span className="chat-loading-dot" />
            <span className="chat-loading-dot" />
            <span className="chat-loading-dot" />
          </div>
        ) : (
          messages.map((msg, idx) => (
            <ChatMessageItem
              key={msg.id}
              message={msg}
              storageId={storageId}
              onPromptClick={(p) => void send(p)}
              onToggleRaw={() => toggleRawMode(msg.id)}
              onEdit={msg.role === "user" ? () => handleEditUserMsg(msg.content) : undefined}
              onRetry={msg.role === "assistant" ? () => handleRetryLast(idx) : undefined}
            />
          ))
        )}
        {busy ? (
          <div className="chat-message-row chat-message-assistant">
            <div className="chat-avatar-bot">
              <Bot size={16} />
            </div>
            <div className="chat-bubble chat-bubble-assistant chat-bubble-loading">
              <span className="chat-loading-dot" />
              <span className="chat-loading-dot" />
              <span className="chat-loading-dot" />
            </div>
          </div>
        ) : null}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-footer">
        <div className="chat-quick-prompts">
          {suggestedPrompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className="chat-prompt-chip"
              onClick={() => void send(prompt)}
              disabled={busy}
            >
              {prompt}
            </button>
          ))}
        </div>

        <div className="chat-input-bar">
          <textarea
            ref={inputRef}
            className="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="输入自然语言指令（如：搜 孤独摇滚、查看当前任务进度...）"
            rows={1}
          />
          <button
            type="button"
            className="chat-send-btn"
            onClick={() => void send(input)}
            disabled={busy || !input.trim()}
            aria-label="发送消息"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
