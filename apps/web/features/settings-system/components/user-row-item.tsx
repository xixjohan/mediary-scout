"use client";

import { useState } from "react";
import {
  Shield,
  KeyRound,
  UserCheck,
  UserX,
  Eye,
  EyeOff,
} from "lucide-react";
import type { RoleEntity } from "@media-track/shared";

export interface ManagedUserViewItem {
  id: string;
  username: string;
  isOwner: boolean;
  roleId: string;
  roleName: string;
  roleLevel: number;
  securityVersion: number;
  isActive: boolean;
  createdAt: string;
}

export interface UserRowProps {
  user: ManagedUserViewItem;
  roles: RoleEntity[];
  isPending: boolean;
  isResetting: boolean;
  newPassword: string;
  onRoleChange: (userId: string, roleId: string) => void;
  onToggleActive: (user: ManagedUserViewItem) => void;
  onToggleResetting: (userId: string) => void;
  onNewPasswordChange: (pw: string) => void;
  onResetPassword: (userId: string) => void;
  onCancelReset: () => void;
}

function resolveAvatarGradient(isOwner: boolean, roleLevel: number): string {
  if (isOwner || roleLevel <= 10) {
    return "linear-gradient(135deg, #6366f1 0%, #a855f7 100%)";
  }
  if (roleLevel <= 20) {
    return "linear-gradient(135deg, #0284c7 0%, #06b6d4 100%)";
  }
  if (roleLevel <= 40) {
    return "linear-gradient(135deg, #059669 0%, #10b981 100%)";
  }
  return "linear-gradient(135deg, #475569 0%, #64748b 100%)";
}

export function UserRowItem({
  user,
  roles,
  isPending,
  isResetting,
  newPassword,
  onRoleChange,
  onToggleActive,
  onToggleResetting,
  onNewPasswordChange,
  onResetPassword,
  onCancelReset,
}: UserRowProps) {
  const initial = user.username.trim().charAt(0).toUpperCase() || "U";
  const avatarGradient = resolveAvatarGradient(user.isOwner, user.roleLevel);

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "12px",
        padding: "1rem 1.25rem",
        background: user.isActive ? "var(--bg-surface)" : "var(--bg-hover)",
        opacity: user.isActive ? 1 : 0.8,
        display: "grid",
        gap: "0.85rem",
        transition: "border-color 0.15s ease, background-color 0.15s ease",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "1rem",
        }}
      >
        {/* 用户基本信息 */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.85rem" }}>
          <div
            style={{
              width: "40px",
              height: "40px",
              borderRadius: "50%",
              background: avatarGradient,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "16px",
              fontWeight: 700,
              color: "#ffffff",
              boxShadow: "0 2px 8px rgba(0, 0, 0, 0.3)",
              flexShrink: 0,
            }}
          >
            {initial}
          </div>

          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <strong style={{ fontSize: "1rem", color: "var(--text)" }}>
                {user.username}
              </strong>
              {user.isOwner ? (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "3px",
                    padding: "2px 7px",
                    borderRadius: "999px",
                    fontSize: "0.72rem",
                    fontWeight: 600,
                    backgroundColor: "rgba(99, 102, 241, 0.18)",
                    color: "#818cf8",
                    border: "1px solid rgba(99, 102, 241, 0.35)",
                  }}
                >
                  <Shield size={11} /> 站主 (Owner)
                </span>
              ) : null}

              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  fontSize: "0.72rem",
                  padding: "2px 7px",
                  borderRadius: "999px",
                  backgroundColor: user.isActive ? "rgba(34, 197, 94, 0.15)" : "rgba(239, 68, 68, 0.15)",
                  color: user.isActive ? "#4ade80" : "#f87171",
                  border: `1px solid ${user.isActive ? "rgba(34, 197, 94, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
                }}
              >
                <span
                  style={{
                    width: "5px",
                    height: "5px",
                    borderRadius: "50%",
                    backgroundColor: user.isActive ? "#4ade80" : "#f87171",
                  }}
                />
                {user.isActive ? "正常" : "已停用"}
              </span>
            </div>

            <div
              style={{
                fontSize: "0.75rem",
                color: "var(--text-muted)",
                marginTop: "0.25rem",
                display: "flex",
                gap: "0.6rem",
              }}
            >
              <span>注册: {user.createdAt.slice(0, 10)}</span>
              <span>·</span>
              <span>安全代数: v{user.securityVersion}</span>
            </div>
          </div>
        </div>

        {/* 角色与权限级别控制 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <span style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}>角色:</span>
            <select
              className="input"
              value={user.roleId}
              disabled={user.isOwner || isPending}
              title={user.isOwner ? "站主为系统最高权限，角色不可修改" : undefined}
              onChange={(e) => onRoleChange(user.id, e.target.value)}
              style={{
                padding: "0.3rem 0.6rem",
                fontSize: "0.82rem",
                borderRadius: "8px",
                minWidth: "130px",
                backgroundColor: "var(--bg-card)",
                color: "var(--text)",
                borderColor: "var(--border)",
              }}
            >
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name} (Lv.{role.level})
                </option>
              ))}
            </select>
          </div>

          {/* 操作按钮区 */}
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            {!user.isOwner && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={isPending}
                onClick={() => onToggleActive(user)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.25rem",
                  fontSize: "0.8rem",
                  padding: "0.3rem 0.6rem",
                  color: user.isActive ? "var(--color-danger)" : "var(--color-success)",
                }}
              >
                {user.isActive ? (
                  <>
                    <UserX size={13} /> 停用
                  </>
                ) : (
                  <>
                    <UserCheck size={13} /> 启用
                  </>
                )}
              </button>
            )}

            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={isPending}
              onClick={() => onToggleResetting(user.id)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.25rem",
                fontSize: "0.8rem",
                padding: "0.3rem 0.6rem",
              }}
            >
              <KeyRound size={13} />
              重置密码
            </button>
          </div>
        </div>
      </div>

      {/* 展开的密码重置表单 */}
      {isResetting && (
        <PasswordResetInlineForm
          username={user.username}
          newPassword={newPassword}
          isPending={isPending}
          onPasswordChange={onNewPasswordChange}
          onConfirm={() => onResetPassword(user.id)}
          onCancel={onCancelReset}
        />
      )}
    </div>
  );
}

function PasswordResetInlineForm({
  username,
  newPassword,
  isPending,
  onPasswordChange,
  onConfirm,
  onCancel,
}: {
  username: string;
  newPassword: string;
  isPending: boolean;
  onPasswordChange: (pw: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div
      style={{
        borderTop: "1px dashed var(--border)",
        paddingTop: "0.85rem",
        display: "flex",
        alignItems: "center",
        gap: "0.6rem",
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}>
        为「{username}」设置新密码:
      </span>
      <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
        <input
          type={showPassword ? "text" : "password"}
          className="input"
          value={newPassword}
          onChange={(e) => onPasswordChange(e.target.value)}
          placeholder="新密码（至少 6 位）"
          style={{
            padding: "0.3rem 2rem 0.3rem 0.6rem",
            fontSize: "0.82rem",
            width: "200px",
            backgroundColor: "var(--bg-card)",
            color: "var(--text)",
          }}
        />
        <button
          type="button"
          onClick={() => setShowPassword(!showPassword)}
          aria-label={showPassword ? "隐藏密码" : "显示密码"}
          style={{
            position: "absolute",
            right: "6px",
            background: "none",
            border: "none",
            padding: "2px",
            color: "var(--text-muted)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
          }}
        >
          {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={isPending || newPassword.length < 6}
        onClick={onConfirm}
        style={{ fontSize: "0.8rem" }}
      >
        {isPending ? "重置中..." : "确认重置"}
      </button>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={onCancel}
        style={{ fontSize: "0.8rem" }}
      >
        取消
      </button>
    </div>
  );
}
