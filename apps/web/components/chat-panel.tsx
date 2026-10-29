"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Edit3,
  Eye,
  EyeOff,
  Film,
  Play,
  RotateCcw,
  Send,
  Sparkles,
  Tv,
  User,
  Wrench,
} from "lucide-react";
import type { ActionCardPayload, ChatTurnResult, ToolCallItem } from "../lib/chat-agent-service";
import { MarkdownContent } from "./markdown-content";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  thinking?: string | undefined;
  toolsUsed?: ToolCallItem[] | undefined;
  actionCard?: ActionCardPayload | undefined;
  rawMode?: boolean | undefined;
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

export function ChatPanel({ storageId }: { storageId?: string | undefined }) {
  const [messages, setMessages] = useState<ChatMessage[]>([INITIAL_MESSAGE]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [suggestedPrompts, setSuggestedPrompts] = useState<string[]>(DEFAULT_PROMPTS);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
          body: JSON.stringify({ messages: history, storageId }),
        });

        if (!response.ok) {
          throw new Error(`服务响应异常（${response.status}）`);
        }

        const data = (await response.json()) as ChatTurnResult;
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
    [busy, messages, storageId],
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
      // 找到该 assistant 消息之前最近的一条 user 消息
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
          <div className="chat-avatar-bot">
            <Bot size={20} />
          </div>
          <div>
            <h1 className="chat-title">智能助理</h1>
            <p className="chat-subtitle">Mediary Copilot · 影视检索与管理</p>
          </div>
        </div>
        <div className="chat-status-pill">
          <Sparkles size={13} aria-hidden />
          <span>全能调度模式</span>
        </div>
      </header>

      <div className="chat-message-list">
        {messages.map((msg, idx) => (
          <ChatMessageItem
            key={msg.id}
            message={msg}
            storageId={storageId}
            onPromptClick={(p) => void send(p)}
            onToggleRaw={() => toggleRawMode(msg.id)}
            onEdit={msg.role === "user" ? () => handleEditUserMsg(msg.content) : undefined}
            onRetry={msg.role === "assistant" ? () => handleRetryLast(idx) : undefined}
          />
        ))}
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

function ThinkingCard({ thinking }: { thinking: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="chat-thinking-card">
      <button
        type="button"
        className="chat-thinking-toggle"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <span className="chat-thinking-label">
          <Sparkles size={13} aria-hidden />
          <span>深度思考过程</span>
        </span>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {expanded ? (
        <div className="chat-thinking-body">
          <MarkdownContent content={thinking} />
        </div>
      ) : null}
    </div>
  );
}

function ToolCallCards({ tools }: { tools: ToolCallItem[] }) {
  return (
    <div className="chat-tools-container">
      {tools.map((tool) => (
        <div
          key={tool.id}
          className="chat-tool-pill"
          title={tool.args ? JSON.stringify(tool.args) : undefined}
        >
          <Wrench size={11} className="chat-tool-icon" aria-hidden />
          <span className="chat-tool-name">{tool.toolName}</span>
          <span className="chat-tool-summary">{tool.summary}</span>
        </div>
      ))}
    </div>
  );
}

function MessageActionsToolbar({
  content,
  isUser,
  rawMode,
  onToggleRaw,
  onEdit,
  onRetry,
}: {
  content: string;
  isUser: boolean;
  rawMode?: boolean | undefined;
  onToggleRaw?: (() => void) | undefined;
  onEdit?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [content]);

  return (
    <div className="chat-actions-toolbar">
      <button
        type="button"
        className="chat-action-btn"
        onClick={handleCopy}
        title={copied ? "已复制到剪贴板" : "复制"}
      >
        {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
        <span>{copied ? "已复制" : "复制"}</span>
      </button>

      {!isUser && onToggleRaw ? (
        <button
          type="button"
          className={`chat-action-btn ${rawMode ? "is-active" : ""}`}
          onClick={onToggleRaw}
          title={rawMode ? "切换为排版渲染视图" : "查看原始 Markdown 文本"}
        >
          {rawMode ? <Eye size={12} aria-hidden /> : <EyeOff size={12} aria-hidden />}
          <span>{rawMode ? "预览" : "原文"}</span>
        </button>
      ) : null}

      {!isUser && onRetry ? (
        <button
          type="button"
          className="chat-action-btn"
          onClick={onRetry}
          title="重新生成此条回答"
        >
          <RotateCcw size={12} aria-hidden />
          <span>重试</span>
        </button>
      ) : null}

      {isUser && onEdit ? (
        <button
          type="button"
          className="chat-action-btn"
          onClick={onEdit}
          title="回填至输入框修改"
        >
          <Edit3 size={12} aria-hidden />
          <span>编辑</span>
        </button>
      ) : null}
    </div>
  );
}

function ChatMessageItem({
  message,
  storageId,
  onPromptClick,
  onToggleRaw,
  onEdit,
  onRetry,
}: {
  message: ChatMessage;
  storageId?: string | undefined;
  onPromptClick: (prompt: string) => void;
  onToggleRaw?: (() => void) | undefined;
  onEdit?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
}) {
  const isUser = message.role === "user";

  return (
    <div className={`chat-message-row ${isUser ? "chat-message-user" : "chat-message-assistant"}`}>
      <div className={isUser ? "chat-avatar-user" : "chat-avatar-bot"}>
        {isUser ? <User size={16} /> : <Bot size={16} />}
      </div>
      <div className="chat-message-content">
        <div className={`chat-bubble ${isUser ? "chat-bubble-user" : "chat-bubble-assistant"}`}>
          {message.thinking ? <ThinkingCard thinking={message.thinking} /> : null}
          {message.toolsUsed && message.toolsUsed.length > 0 ? (
            <ToolCallCards tools={message.toolsUsed} />
          ) : null}
          {message.rawMode ? (
            <pre className="chat-raw-text">{message.content}</pre>
          ) : isUser ? (
            <p className="chat-text">{message.content}</p>
          ) : (
            <MarkdownContent content={message.content} />
          )}
          {message.actionCard ? (
            <ActionCardRenderer
              card={message.actionCard}
              storageId={storageId}
              onPromptClick={onPromptClick}
            />
          ) : null}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: isUser ? "flex-end" : "space-between",
            gap: "0.5rem",
          }}
        >
          <MessageActionsToolbar
            content={message.content}
            isUser={isUser}
            rawMode={message.rawMode}
            onToggleRaw={onToggleRaw}
            onEdit={onEdit}
            onRetry={onRetry}
          />
          <span className="chat-timestamp" suppressHydrationWarning>
            {message.timestamp}
          </span>
        </div>
      </div>
    </div>
  );
}

function ActionCardRenderer({
  card,
  storageId,
  onPromptClick,
}: {
  card: ActionCardPayload;
  storageId?: string | undefined;
  onPromptClick: (prompt: string) => void;
}) {
  switch (card.kind) {
    case "media_list":
      return <MediaListCard card={card} storageId={storageId} onPromptClick={onPromptClick} />;
    case "activity_status":
      return <ActivityStatusCard card={card} />;
    case "library_summary":
      return <LibrarySummaryCard card={card} onPromptClick={onPromptClick} />;
    default:
      return null;
  }
}

function MediaListCard({
  card,
  storageId,
  onPromptClick,
}: {
  card: Extract<ActionCardPayload, { kind: "media_list" }>;
  storageId?: string | undefined;
  onPromptClick: (prompt: string) => void;
}) {
  return (
    <div className="chat-action-card media-list-card">
      <div className="media-card-grid">
        {card.items.map((item) => {
          const showHref = storageId
            ? `/show/${item.tmdbId}?from=search&t=${item.mediaType}&w=${encodeURIComponent(storageId)}`
            : `/show/${item.tmdbId}?from=search&t=${item.mediaType}`;
          return (
            <div key={item.tmdbId} className="media-card-item">
              <div className="media-card-poster">
                {item.posterPath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`https://image.tmdb.org/t/p/w185${item.posterPath}`}
                    alt={item.title}
                    className="media-card-img"
                  />
                ) : (
                  <div className="media-card-no-poster">
                    {item.mediaType === "movie" ? <Film size={20} /> : <Tv size={20} />}
                  </div>
                )}
              </div>
              <div className="media-card-meta">
                <span className="media-card-title">{item.title}</span>
                <div className="media-card-tags">
                  <span className="media-card-badge">
                    {item.mediaType === "movie" ? "电影" : "剧集"}
                  </span>
                  {item.year ? <span className="media-card-year">{item.year}</span> : null}
                  {item.statusText ? (
                    <span className="media-card-badge media-card-status-badge">
                      {item.statusText}
                    </span>
                  ) : null}
                </div>
                <div className="media-card-actions">
                  <Link href={showHref} className="media-card-btn">
                    <Play size={11} /> 查看详情
                  </Link>
                  <button
                    type="button"
                    className="media-card-btn-secondary"
                    onClick={() => onPromptClick(`搜《${item.title}》的资源`)}
                  >
                    查资源
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActivityStatusCard({
  card,
}: {
  card: Extract<ActionCardPayload, { kind: "activity_status" }>;
}) {
  return (
    <div className="chat-action-card activity-card">
      <div className="activity-card-header">
        <Sparkles size={14} />
        <span>当前任务队列（{card.activeRuns.length}）</span>
      </div>
      <ul className="activity-card-list">
        {card.activeRuns.map((run) => (
          <li key={run.id} className="activity-card-item">
            <div className="activity-item-info">
              <span className="activity-item-title">{run.title}</span>
              <span className="activity-item-phase">{run.phase}</span>
            </div>
            {run.progress !== undefined ? (
              <div className="activity-progress-bar">
                <div
                  className="activity-progress-inner"
                  style={{ width: `${Math.min(100, Math.max(0, run.progress))}%` }}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function LibrarySummaryCard({
  card,
  onPromptClick,
}: {
  card: Extract<ActionCardPayload, { kind: "library_summary" }>;
  onPromptClick: (prompt: string) => void;
}) {
  return (
    <div className="chat-action-card library-card">
      <div className="library-card-header">
        <CheckCircle2 size={14} />
        <span>当前订阅总数：{card.trackedCount} 部</span>
      </div>
      <div className="library-card-tags">
        {card.items.map((item) => (
          <button
            key={item.tmdbId}
            type="button"
            className="library-card-tag"
            onClick={() => onPromptClick(`搜《${item.title}》`)}
          >
            {item.title}
          </button>
        ))}
      </div>
    </div>
  );
}
