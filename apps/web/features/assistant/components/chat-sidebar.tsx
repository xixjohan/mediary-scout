"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  Edit3,
  MessageSquare,
  PanelLeftClose,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  groupConversationsByDate,
  type ChatConversationSummary,
} from "../../../lib/chat-types";

export interface ChatSidebarProps {
  conversations: ChatConversationSummary[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function ChatSidebar({
  conversations,
  activeId,
  onSelect,
  onNewChat,
  onDelete,
  onRename,
  collapsed = false,
  onToggleCollapse,
}: ChatSidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const startRename = (conv: ChatConversationSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(conv.id);
    setEditTitle(conv.title);
  };

  const submitRename = (id: string) => {
    const trimmed = editTitle.trim();
    if (trimmed && trimmed !== "") {
      onRename(id, trimmed);
    }
    setEditingId(null);
  };

  const cancelRename = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setEditingId(null);
  };

  const handleDeleteClick = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm("确定要删除此会话记录吗？删除后将无法恢复。")) {
      onDelete(id);
    }
  };

  if (collapsed) {
    return null;
  }

  const groups = groupConversationsByDate(conversations);

  return (
    <aside className="chat-sidebar" aria-label="会话列表">
      <div className="chat-sidebar-header">
        <button
          type="button"
          className="chat-sidebar-new-btn"
          onClick={onNewChat}
          title="新建对话"
        >
          <Plus size={16} aria-hidden />
          <span>新建对话</span>
        </button>

        {onToggleCollapse ? (
          <button
            type="button"
            className="chat-sidebar-collapse-btn"
            onClick={onToggleCollapse}
            title="收起会话侧栏"
            aria-label="收起会话侧栏"
          >
            <PanelLeftClose size={18} />
          </button>
        ) : null}
      </div>

      <div className="chat-sidebar-content">
        {conversations.length === 0 ? (
          <div className="chat-sidebar-empty">
            <MessageSquare size={28} className="chat-sidebar-empty-icon" aria-hidden />
            <p className="chat-sidebar-empty-text">暂无历史会话</p>
            <p className="chat-sidebar-empty-hint">发送第一条消息后将自动存档</p>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.key} className="chat-sidebar-group">
              <div className="chat-sidebar-group-title">{group.label}</div>
              <ul className="chat-sidebar-group-list">
                {group.items.map((conv) => {
                  const isActive = conv.id === activeId;
                  const isEditing = conv.id === editingId;

                  return (
                    <li
                      key={conv.id}
                      className={`chat-sidebar-item ${isActive ? "is-active" : ""}`}
                      onClick={() => {
                        if (!isEditing) onSelect(conv.id);
                      }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if ((e.key === "Enter" || e.key === " ") && !isEditing) {
                          e.preventDefault();
                          onSelect(conv.id);
                        }
                      }}
                    >
                      {isEditing ? (
                        <div
                          className="chat-sidebar-rename-form"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            ref={editInputRef}
                            type="text"
                            className="chat-sidebar-rename-input"
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                submitRename(conv.id);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                cancelRename();
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="chat-sidebar-icon-btn"
                            onClick={() => submitRename(conv.id)}
                            title="保存"
                          >
                            <Check size={13} />
                          </button>
                          <button
                            type="button"
                            className="chat-sidebar-icon-btn"
                            onClick={cancelRename}
                            title="取消"
                          >
                            <X size={13} />
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="chat-sidebar-item-main">
                            <span className="chat-sidebar-item-title" title={conv.title}>
                              {conv.title}
                            </span>
                          </div>

                          <div className="chat-sidebar-item-actions">
                            <button
                              type="button"
                              className="chat-sidebar-action-btn"
                              onClick={(e) => startRename(conv, e)}
                              title="重命名"
                              aria-label="重命名"
                            >
                              <Edit3 size={13} />
                            </button>
                            <button
                              type="button"
                              className="chat-sidebar-action-btn is-danger"
                              onClick={(e) => handleDeleteClick(conv.id, e)}
                              title="删除会话"
                              aria-label="删除会话"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
