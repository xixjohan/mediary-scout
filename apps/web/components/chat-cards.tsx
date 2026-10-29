"use client";

import { useCallback, useState } from "react";
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
  Sparkles,
  Tv,
  User,
  Wrench,
} from "lucide-react";
import type { ActionCardPayload, ToolCallItem } from "../lib/chat-agent-service";
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

export function ThinkingCard({ thinking }: { thinking: string }) {
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

export function ToolCallCards({ tools }: { tools: ToolCallItem[] }) {
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

export function MessageActionsToolbar({
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

export function ChatMessageItem({
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

export function ActionCardRenderer({
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

export function MediaListCard({
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

export function ActivityStatusCard({
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

export function LibrarySummaryCard({
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
