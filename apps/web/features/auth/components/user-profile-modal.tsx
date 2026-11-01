"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Shield, HardDrive, Calendar, KeyRound, LogOut, CheckCircle2 } from "lucide-react";
import { useAuth } from "../hooks/use-auth";

export function UserProfileModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { user, logout, isOwner } = useAuth();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Escape 键快捷关闭
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // 背景滚动穿透阻断（Body Scroll Lock）
  useEffect(() => {
    if (!isOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

  if (!isOpen || !user || !mounted) return null;

  const initial = user.username.trim().charAt(0).toUpperCase() || "U";
  const formattedDate = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
    : "刚刚";

  return createPortal(
    <div
      className="modal-backdrop user-profile-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="user-profile-title"
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.7)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "16px",
        animation: "fadeIn 0.15s ease-out",
      }}
    >
      <div
        className="panel user-profile-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "480px",
          borderRadius: "14px",
          border: "1px solid var(--border-color)",
          backgroundColor: "var(--bg-card)",
          color: "var(--text)",
          boxShadow: "0 24px 48px rgba(0, 0, 0, 0.65)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "20px 24px 16px",
            borderBottom: "1px solid var(--border-color)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
            <div
              style={{
                width: "48px",
                height: "48px",
                borderRadius: "50%",
                background: isOwner
                  ? "linear-gradient(135deg, #6366f1 0%, #a855f7 100%)"
                  : "linear-gradient(135deg, #0ea5e9 0%, #10b981 100%)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "20px",
                fontWeight: 700,
                color: "#ffffff",
                boxShadow: isOwner
                  ? "0 4px 14px rgba(99, 102, 241, 0.4)"
                  : "0 4px 14px rgba(16, 185, 129, 0.4)",
              }}
            >
              {initial}
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <h3 id="user-profile-title" style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>
                  {user.username}
                </h3>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: "2px 8px",
                    borderRadius: "999px",
                    fontSize: "11px",
                    fontWeight: 500,
                    backgroundColor: isOwner ? "rgba(99, 102, 241, 0.15)" : "rgba(34, 197, 94, 0.15)",
                    color: isOwner ? "#818cf8" : "#4ade80",
                    border: `1px solid ${isOwner ? "rgba(99, 102, 241, 0.3)" : "rgba(34, 197, 94, 0.3)"}`,
                  }}
                >
                  <Shield size={11} />
                  {user.role?.name ?? (isOwner ? "站长 (Owner)" : "成员")}
                </span>
              </div>
              <p style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--text-muted)" }}>
                ID: {user.id}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              padding: "6px",
              borderRadius: "8px",
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "20px 24px" }}>
          {/* Stat Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "20px" }}>
            <div
              style={{
                padding: "12px 14px",
                borderRadius: "10px",
                backgroundColor: "var(--bg-raised)",
                border: "1px solid var(--border-subtle)",
                display: "flex",
                alignItems: "center",
                gap: "10px",
              }}
            >
              <HardDrive size={18} style={{ color: "#38bdf8" }} />
              <div>
                <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>关联网盘</div>
                <div style={{ fontSize: "15px", fontWeight: 600 }}>{user.storageCount} 个存储</div>
              </div>
            </div>
            <div
              style={{
                padding: "12px 14px",
                borderRadius: "10px",
                backgroundColor: "var(--bg-raised)",
                border: "1px solid var(--border-subtle)",
                display: "flex",
                alignItems: "center",
                gap: "10px",
              }}
            >
              <Calendar size={18} style={{ color: "#f472b6" }} />
              <div>
                <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>注册日期</div>
                <div style={{ fontSize: "14px", fontWeight: 600 }}>{formattedDate}</div>
              </div>
            </div>
          </div>

          {/* Permissions Cloud */}
          <div>
            <div
              style={{
                fontSize: "12px",
                fontWeight: 600,
                color: "var(--text-muted)",
                marginBottom: "8px",
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>拥有功能特权</span>
              <span>{isOwner ? "无限制 (*)" : `${user.permissions.length} 项`}</span>
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "6px",
                maxHeight: "130px",
                overflowY: "auto",
                padding: "8px",
                borderRadius: "8px",
                backgroundColor: "var(--bg-raised)",
                border: "1px solid var(--border-subtle)",
              }}
            >
              {isOwner ? (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: "3px 8px",
                    borderRadius: "6px",
                    fontSize: "11px",
                    backgroundColor: "rgba(99, 102, 241, 0.2)",
                    color: "#a5b4fc",
                    fontWeight: 500,
                  }}
                >
                  <CheckCircle2 size={12} /> 系统所有特权 (Wildcard *)
                </span>
              ) : user.permissions.length > 0 ? (
                user.permissions.map((p) => (
                  <span
                    key={p}
                    style={{
                      padding: "2px 7px",
                      borderRadius: "4px",
                      fontSize: "11px",
                      backgroundColor: "rgba(255, 255, 255, 0.06)",
                      color: "var(--text)",
                    }}
                  >
                    {p}
                  </span>
                ))
              ) : (
                <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>暂无专属特权</span>
              )}
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div
          style={{
            padding: "14px 24px",
            borderTop: "1px solid var(--border-color)",
            backgroundColor: "rgba(0, 0, 0, 0.2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: "10px",
          }}
        >
          <a
            href="/settings?tab=account#password"
            className="btn btn-secondary"
            onClick={onClose}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 14px",
              borderRadius: "8px",
              fontSize: "13px",
              textDecoration: "none",
            }}
          >
            <KeyRound size={13} />
            修改密码
          </a>
          <button
            type="button"
            onClick={logout}
            className="btn btn-danger"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 14px",
              borderRadius: "8px",
              fontSize: "13px",
              backgroundColor: "rgba(239, 68, 68, 0.15)",
              color: "#f87171",
              border: "1px solid rgba(239, 68, 68, 0.3)",
              cursor: "pointer",
            }}
          >
            <LogOut size={13} />
            退出登录
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
