"use client";

import { useEffect, useState, useTransition, useMemo } from "react";
import {
  Shield,
  UserCheck,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Search,
  Eye,
  EyeOff,
  UserPlus,
} from "lucide-react";
import type { RoleEntity } from "@media-track/shared";
import { UserRowItem, type ManagedUserViewItem } from "./user-row-item";
import {
  UserActionConfirmDialog,
  type ConfirmDialogSpec,
} from "./user-action-confirm-dialog";

export function UserManagementView() {
  const [users, setUsers] = useState<ManagedUserViewItem[]>([]);
  const [roles, setRoles] = useState<RoleEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // 搜索过滤状态
  const [searchQuery, setSearchQuery] = useState("");

  // 重置密码弹窗/内联状态
  const [resettingUserId, setResettingUserId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");

  // 新建用户状态
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createUsername, setCreateUsername] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [showCreatePassword, setShowCreatePassword] = useState(false);
  const [createRoleId, setCreateRoleId] = useState("role_member");

  // 内建通用操作确认弹窗状态（替代阻塞型 window.confirm）
  const [confirmDialogSpec, setConfirmDialogSpec] = useState<ConfirmDialogSpec | null>(null);
  const [pendingConfirmAction, setPendingConfirmAction] = useState<(() => Promise<void>) | null>(null);

  const [isPending, startTransition] = useTransition();

  const flash = (msg: string, isErr = false) => {
    if (isErr) {
      setErrorMsg(msg);
      setTimeout(() => setErrorMsg(null), 5000);
    } else {
      setSuccessMsg(msg);
      setTimeout(() => setSuccessMsg(null), 4000);
    }
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const [usersRes, rolesRes] = await Promise.all([
        fetch("/api/settings/users"),
        fetch("/api/settings/roles"),
      ]);

      if (usersRes.ok) {
        const usersData = await usersRes.json();
        setUsers(usersData);
      } else {
        const err = await usersRes.json().catch(() => null);
        flash(err?.error || "加载用户列表失败", true);
      }

      if (rolesRes.ok) {
        const rolesData = await rolesRes.json();
        setRoles(rolesData);
      }
    } catch (e) {
      flash(String(e), true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleRoleChange = (userId: string, newRoleId: string) => {
    const targetUser = users.find((u) => u.id === userId);
    if (!targetUser) return;
    const targetRoleName = roles.find((r) => r.id === newRoleId)?.name || newRoleId;

    setConfirmDialogSpec({
      title: "调整用户角色",
      description: `确认将用户「${targetUser.username}」的角色调整为「${targetRoleName}」吗？\n该用户的所有 API Key 将立即联动同步安全版本。`,
      confirmLabel: "确认调整",
      isDanger: false,
    });

    setPendingConfirmAction(() => async () => {
      try {
        const res = await fetch(`/api/settings/users/${userId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "set_role", roleId: newRoleId }),
        });
        const data = await res.json();
        if (!res.ok) {
          flash(data?.error || "角色变更失败", true);
          return;
        }
        flash(data?.message || "角色变更成功");
        void loadData();
      } catch (err) {
        flash(String(err), true);
      } finally {
        setConfirmDialogSpec(null);
        setPendingConfirmAction(null);
      }
    });
  };

  const handleToggleActive = (user: ManagedUserViewItem) => {
    const nextState = !user.isActive;
    const actionDesc = nextState ? "启用" : "停用";

    setConfirmDialogSpec({
      title: `${actionDesc}用户账号`,
      description: `确认${actionDesc}用户「${user.username}」吗？\n${
        nextState
          ? "恢复后该用户可正常登录系统并调用已授权的 API Key。"
          : "停用后该用户的所有登录会话和 API Key 将被立即冻结拒绝。"
      }`,
      confirmLabel: `确认${actionDesc}`,
      isDanger: !nextState,
    });

    setPendingConfirmAction(() => async () => {
      try {
        const res = await fetch(`/api/settings/users/${user.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "set_active", isActive: nextState }),
        });
        const data = await res.json();
        if (!res.ok) {
          flash(data?.error || `${actionDesc}失败`, true);
          return;
        }
        flash(data?.message || `用户已成功${actionDesc}`);
        void loadData();
      } catch (err) {
        flash(String(err), true);
      } finally {
        setConfirmDialogSpec(null);
        setPendingConfirmAction(null);
      }
    });
  };

  const handleResetPassword = (userId: string) => {
    if (!newPassword || newPassword.length < 6) {
      flash("新密码长度至少需要 6 个字符", true);
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(`/api/settings/users/${userId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reset_password", newPassword }),
        });
        const data = await res.json();
        if (!res.ok) {
          flash(data?.error || "密码重置失败", true);
          return;
        }
        flash(data?.message || "密码重置成功，旧会话已安全销毁");
        setResettingUserId(null);
        setNewPassword("");
        void loadData();
      } catch (err) {
        flash(String(err), true);
      }
    });
  };

  const handleCreateUser = (e: React.FormEvent) => {
    e.preventDefault();
    if (!createUsername.trim() || createPassword.length < 6) {
      flash("用户名至少 2 个字符、初始密码至少 6 位", true);
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch("/api/settings/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: createUsername.trim(),
            password: createPassword,
            roleId: createRoleId,
          }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok) {
          flash(`新用户「${createUsername.trim()}」创建成功！`);
          setShowCreateForm(false);
          setCreateUsername("");
          setCreatePassword("");
          setCreateRoleId("role_member");
          void loadData();
        } else {
          flash(data?.error || "创建用户失败", true);
        }
      } catch (err) {
        flash(String(err), true);
      }
    });
  };

  const filteredUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        u.roleName.toLowerCase().includes(q)
    );
  }, [users, searchQuery]);

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      {/* 消息提示横幅 */}
      {errorMsg && (
        <div
          className="notice is-error"
          style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}
        >
          <AlertCircle size={16} />
          <span>{errorMsg}</span>
        </div>
      )}

      {successMsg && (
        <div
          className="notice is-success"
          style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}
        >
          <CheckCircle2 size={16} />
          <span>{successMsg}</span>
        </div>
      )}

      {/* 头部操作与搜索栏 */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "0.75rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.9rem", color: "var(--text-muted)" }}>
            已注册用户: <strong>{users.length}</strong> 位
          </span>

          {users.length > 2 && (
            <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
              <Search
                size={14}
                style={{
                  position: "absolute",
                  left: "8px",
                  color: "var(--text-muted)",
                  pointerEvents: "none",
                }}
              />
              <input
                type="text"
                placeholder="搜索用户或角色..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  padding: "0.3rem 0.6rem 0.3rem 1.8rem",
                  fontSize: "0.82rem",
                  borderRadius: "8px",
                  backgroundColor: "var(--bg-card)",
                  color: "var(--text)",
                  border: "1px solid var(--border)",
                  width: "160px",
                }}
              />
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setShowCreateForm(!showCreateForm)}
            style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
          >
            {showCreateForm ? <UserCheck size={14} /> : <UserPlus size={14} />}
            {showCreateForm ? "取消新建" : "➕ 添加新用户"}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void loadData()}
            disabled={loading || isPending}
            style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
          >
            <RefreshCw size={13} className={loading ? "spin" : ""} />
            刷新
          </button>
        </div>
      </div>

      {/* 新建用户表单面板 */}
      {showCreateForm && (
        <form
          onSubmit={handleCreateUser}
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "12px",
            padding: "1.25rem 1.5rem",
            display: "grid",
            gap: "0.85rem",
            animation: "fadeIn 0.15s ease-out",
          }}
        >
          <div style={{ fontWeight: 600, fontSize: "0.95rem", color: "var(--text)" }}>
            添加新用户账号
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "0.85rem",
            }}
          >
            <div>
              <label style={{ display: "block", fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "4px" }}>
                用户名
              </label>
              <input
                type="text"
                className="setting-control"
                value={createUsername}
                onChange={(e) => setCreateUsername(e.target.value)}
                placeholder="例如: family_member"
                required
                autoFocus
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "4px" }}>
                初始密码（至少 6 位）
              </label>
              <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                <input
                  type={showCreatePassword ? "text" : "password"}
                  className="setting-control"
                  value={createPassword}
                  onChange={(e) => setCreatePassword(e.target.value)}
                  placeholder="设置初始密码"
                  required
                  style={{ paddingRight: "2.2rem" }}
                />
                <button
                  type="button"
                  onClick={() => setShowCreatePassword(!showCreatePassword)}
                  aria-label={showCreatePassword ? "隐藏密码" : "显示密码"}
                  style={{
                    position: "absolute",
                    right: "8px",
                    background: "none",
                    border: "none",
                    padding: "4px",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  {showCreatePassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "4px" }}>
                分配系统角色
              </label>
              <select
                className="setting-control"
                value={createRoleId}
                onChange={(e) => setCreateRoleId(e.target.value)}
              >
                {roles
                  .filter((r) => r.id !== "role_owner")
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} (等级: {r.level})
                    </option>
                  ))}
              </select>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "0.25rem" }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setShowCreateForm(false);
                setCreateUsername("");
                setCreatePassword("");
              }}
            >
              取消
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={isPending}>
              {isPending ? "正在创建..." : "确认创建用户"}
            </button>
          </div>
        </form>
      )}

      {/* 单用户默认状态引导横幅 */}
      {users.length <= 1 && !loading && (
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "10px",
            padding: "0.85rem 1.1rem",
            fontSize: "0.85rem",
            color: "var(--text-muted)",
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
          }}
        >
          <Shield size={16} style={{ color: "var(--accent)", flexShrink: 0 }} />
          <span>
            当前处于单用户默认状态。点击上方「添加新用户」即可随时邀请家人或朋友加入，系统将自动开启多账号独立媒体库与个性化追更隔离。
          </span>
        </div>
      )}

      {/* 用户列表 */}
      {loading && users.length === 0 ? (
        <div style={{ textAlign: "center", padding: "2.5rem", color: "var(--text-muted)" }}>
          正在加载用户列表...
        </div>
      ) : filteredUsers.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "2.5rem",
            color: "var(--text-muted)",
            border: "1px dashed var(--border)",
            borderRadius: "10px",
          }}
        >
          {searchQuery ? "未找到匹配的用户" : "暂无多用户数据"}
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.85rem" }}>
          {filteredUsers.map((user) => (
            <UserRowItem
              key={user.id}
              user={user}
              roles={roles}
              isPending={isPending}
              isResetting={resettingUserId === user.id}
              newPassword={newPassword}
              onRoleChange={handleRoleChange}
              onToggleActive={handleToggleActive}
              onToggleResetting={(id) => {
                setResettingUserId(resettingUserId === id ? null : id);
                setNewPassword("");
              }}
              onNewPasswordChange={setNewPassword}
              onResetPassword={handleResetPassword}
              onCancelReset={() => {
                setResettingUserId(null);
                setNewPassword("");
              }}
            />
          ))}
        </div>
      )}

      {/* 应用内通用确认弹窗 */}
      <UserActionConfirmDialog
        spec={confirmDialogSpec}
        isPending={isPending}
        onConfirm={() => {
          if (pendingConfirmAction) {
            startTransition(() => {
              void pendingConfirmAction();
            });
          }
        }}
        onCancel={() => {
          setConfirmDialogSpec(null);
          setPendingConfirmAction(null);
        }}
      />
    </div>
  );
}
