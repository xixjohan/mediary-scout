"use client";

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import {
  Shield,
  Plus,
  Sliders,
  Trash2,
  Check,
  ChevronDown,
  ChevronUp,
  X,
  Lock,
} from "lucide-react";
import {
  PERMISSION_CATALOG,
  ApiKeyPermissionPreset,
  type ApiKeyPermissionModule,
  type RoleEntity,
} from "@media-track/shared";
import { UserActionConfirmDialog } from "./user-action-confirm-dialog";

export function RoleManagementPanel() {
  const [roles, setRoles] = useState<RoleEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // 编辑角色弹窗状态
  const [editingRole, setEditingRole] = useState<RoleEntity | null>(null);
  const [rolePermissions, setRolePermissions] = useState<string[]>([]);
  const [expandedModules, setExpandedModules] = useState<Record<string, boolean>>({
    media: true,
    storage: true,
    workflow: true,
    assistant: true,
    system: true,
  });

  // 新建角色弹窗状态
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleDesc, setNewRoleDesc] = useState("");
  const [newRoleLevel, setNewRoleLevel] = useState<number>(40);
  const [newRolePermissions, setNewRolePermissions] = useState<string[]>([]);

  const [mounted, setMounted] = useState(false);
  const [deleteConfirmRole, setDeleteConfirmRole] = useState<RoleEntity | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const [isPending, startTransition] = useTransition();

  const flash = (msg: string, isErr = false) => {
    if (isErr) {
      setErrorMsg(msg);
      setTimeout(() => setErrorMsg(null), 4000);
    } else {
      setSuccessMsg(msg);
      setTimeout(() => setSuccessMsg(null), 3000);
    }
  };

  const fetchRoles = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings/roles");
      if (res.ok) {
        const data = await res.json();
        setRoles(data);
      } else {
        const err = await res.json().catch(() => null);
        flash(err?.error || "加载角色列表失败", true);
      }
    } catch (e) {
      flash(String(e), true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchRoles();
  }, []);

  const openEditDrawer = (role: RoleEntity) => {
    setEditingRole(role);
    setRolePermissions([...role.permissions]);
  };

  const handleToggleModule = (module: ApiKeyPermissionModule) => {
    const currentSet = new Set(rolePermissions);
    const state = ApiKeyPermissionPreset.calculateModuleState(module, currentSet);
    const shouldCheckAll = state !== "checked";
    const next = ApiKeyPermissionPreset.toggleModule(module, rolePermissions, shouldCheckAll);
    setRolePermissions(next);
  };

  const handleToggleLeaf = (leafId: string) => {
    setRolePermissions((prev) =>
      prev.includes(leafId) ? prev.filter((id) => id !== leafId) : [...prev, leafId]
    );
  };

  const handleSaveRolePermissions = () => {
    if (!editingRole) return;

    startTransition(async () => {
      try {
        const res = await fetch(`/api/settings/roles/${editingRole.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ permissions: rolePermissions }),
        });

        if (res.ok) {
          flash(`角色 [${editingRole.name}] 权限配置已保存`);
          setEditingRole(null);
          void fetchRoles();
        } else {
          const err = await res.json().catch(() => null);
          flash(err?.error || "保存失败", true);
        }
      } catch (e) {
        flash(String(e), true);
      }
    });
  };

  const handleCreateRole = () => {
    if (!newRoleName.trim()) {
      flash("请输入角色名称", true);
      return;
    }

    startTransition(async () => {
      try {
        const res = await fetch("/api/settings/roles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: newRoleName.trim(),
            description: newRoleDesc.trim(),
            level: newRoleLevel,
            permissions: newRolePermissions,
          }),
        });

        if (res.ok) {
          flash(`成功创建自定义角色: ${newRoleName}`);
          setShowCreateModal(false);
          setNewRoleName("");
          setNewRoleDesc("");
          setNewRolePermissions([]);
          void fetchRoles();
        } else {
          const err = await res.json().catch(() => null);
          flash(err?.error || "创建角色失败", true);
        }
      } catch (e) {
        flash(String(e), true);
      }
    });
  };

  const handleDeleteRole = (role: RoleEntity) => {
    setDeleteConfirmRole(role);
  };

  return (
    <section className="panel" style={{ maxWidth: 760, marginTop: 24 }}>
      <div className="panel-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h2 className="panel-title">
            <Shield size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            角色与模块权限管理 (RBAC)
          </h2>
          <p className="panel-note">
            定义系统角色及其可访问的功能模块树。角色权限直接作为 API Key 授权的委托上限边界，杜绝越权提权。
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setShowCreateModal(true)}
          style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          <Plus size={14} /> 新建角色
        </button>
      </div>

      {errorMsg && (
        <div style={{ margin: "0.8rem 0", padding: "0.5rem 0.8rem", background: "var(--color-danger-subtle)", color: "var(--color-danger)", borderRadius: 6, fontSize: "0.85rem" }}>
          {errorMsg}
        </div>
      )}
      {successMsg && (
        <div style={{ margin: "0.8rem 0", padding: "0.5rem 0.8rem", background: "var(--color-success-subtle)", color: "var(--color-success)", borderRadius: 6, fontSize: "0.85rem" }}>
          {successMsg}
        </div>
      )}

      {loading ? (
        <div style={{ padding: "1.5rem", textAlign: "center", color: "var(--text-muted)" }}>
          正在加载角色权限矩阵…
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.6rem" }}>
          {roles.map((r) => (
            <div
              key={r.id}
              style={{
                border: "1px solid var(--border-subtle)",
                borderRadius: 8,
                padding: "0.75rem 1rem",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: "var(--bg-surface)",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <strong style={{ fontSize: "0.95rem" }}>{r.name}</strong>
                  <span className={`badge ${r.level <= 10 ? "is-error" : r.level <= 20 ? "is-warn" : "is-on"}`} style={{ fontSize: "0.7rem" }}>
                    Level {r.level}
                  </span>
                  {r.isSystem && (
                    <span className="badge" style={{ fontSize: "0.7rem", background: "var(--bg-hover)" }}>
                      内置角色
                    </span>
                  )}
                </div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 2 }}>
                  {r.description || "无描述"} · 包含 {r.permissions.includes("*") ? "全部" : r.permissions.length} 项功能模块
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => openEditDrawer(r)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                >
                  <Sliders size={13} /> 配置模块权限
                </button>
                {!r.isSystem && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleDeleteRole(r)}
                    style={{ color: "var(--color-danger, #ef4444)" }}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 编辑角色权限弹窗 */}
      {editingRole && mounted &&
        createPortal(
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 16 }}>
          <div style={{ background: "var(--bg-surface)", width: "100%", maxWidth: 640, maxHeight: "90vh", borderRadius: 10, display: "flex", flexDirection: "column", overflow: "hidden", border: "1px solid var(--border-subtle)" }}>
            <div style={{ padding: "0.8rem 1.2rem", borderBottom: "1px solid var(--border-subtle)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h3 style={{ margin: 0, fontSize: "1.05rem" }}>配置角色权限：{editingRole.name}</h3>
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Level {editingRole.level} · 勾选此角色可访问的功能模块</span>
              </div>
              <button type="button" onClick={() => setEditingRole(null)} style={{ border: "none", background: "transparent", cursor: "pointer" }}>
                <X size={18} />
              </button>
            </div>

            <div style={{ padding: "1rem 1.2rem", overflowY: "auto", flex: 1, display: "grid", gap: "0.6rem" }}>
              {editingRole.id === "role_owner" && (
                <div style={{ padding: "0.6rem 0.8rem", background: "var(--color-info-subtle)", borderRadius: 6, fontSize: "0.85rem", color: "var(--color-brand-primary)" }}>
                  💡 站长 (Owner) 自带通配符 <code>*</code> 权限，始终拥有系统 100% 全部业务与底层配置特权。
                </div>
              )}

              {PERMISSION_CATALOG.map((module) => {
                const modState = ApiKeyPermissionPreset.calculateModuleState(module, new Set(rolePermissions));
                const isExpanded = expandedModules[module.id] ?? true;

                return (
                  <div key={module.id} style={{ border: "1px solid var(--border-subtle)", borderRadius: 6, overflow: "hidden" }}>
                    <div style={{ background: "var(--bg-hover)", padding: "0.45rem 0.75rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <label style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", fontWeight: 600, fontSize: "0.88rem" }}>
                        <input
                          type="checkbox"
                          checked={modState === "checked"}
                          ref={(el) => {
                            if (el) el.indeterminate = modState === "indeterminate";
                          }}
                          onChange={() => handleToggleModule(module)}
                        />
                        {module.name}
                        <span style={{ fontSize: "0.75rem", fontWeight: "normal", color: "var(--text-muted)" }}>
                          ({module.description})
                        </span>
                      </label>
                      <button
                        type="button"
                        onClick={() => setExpandedModules((prev) => ({ ...prev, [module.id]: !prev[module.id] }))}
                        style={{ border: "none", background: "transparent", cursor: "pointer" }}
                      >
                        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                    </div>

                    {isExpanded && (
                      <div style={{ padding: "0.5rem 0.8rem", display: "grid", gap: "0.4rem", background: "var(--bg-surface)" }}>
                        {module.leaves.map((leaf) => {
                          const checked = rolePermissions.includes(leaf.id) || rolePermissions.includes("*");
                          return (
                            <label key={leaf.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.85rem", cursor: "pointer" }}>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem" }}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => handleToggleLeaf(leaf.id)}
                                />
                                <strong>{leaf.name}</strong>
                                <span style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>{leaf.description}</span>
                              </span>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                                {leaf.supportsMcp && (
                                  <span className="badge" style={{ fontSize: "0.65rem", padding: "0.1rem 0.35rem", background: "rgba(16,185,129,0.15)", color: "#10b981" }}>
                                    MCP
                                  </span>
                                )}
                                <span className={`badge ${leaf.riskLevel === "Dangerous" ? "is-error" : leaf.riskLevel === "Execute" ? "is-warn" : "is-on"}`} style={{ fontSize: "0.65rem", padding: "0.1rem 0.35rem" }}>
                                  {leaf.riskLevel}
                                </span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div style={{ padding: "0.8rem 1.2rem", borderTop: "1px solid var(--border-subtle)", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <button type="button" className="btn btn-secondary" onClick={() => setEditingRole(null)}>
                取消
              </button>
              <button type="button" className="btn btn-primary" onClick={handleSaveRolePermissions} disabled={isPending}>
                {isPending ? "正在保存…" : "保存权限"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 新建角色弹窗 */}
      {showCreateModal && mounted &&
        createPortal(
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 16 }}>
          <div style={{ background: "var(--bg-surface)", width: "100%", maxWidth: 500, borderRadius: 10, padding: "1.2rem", border: "1px solid var(--border-subtle)", display: "grid", gap: "0.8rem" }}>
            <h3 style={{ margin: 0, fontSize: "1.1rem" }}>新建自定义角色</h3>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", marginBottom: 4 }}>角色名称</label>
              <input
                type="text"
                className="input"
                value={newRoleName}
                onChange={(e) => setNewRoleName(e.target.value)}
                placeholder="例如: 影音归档专员"
                style={{ width: "100%" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", marginBottom: 4 }}>角色职责描述</label>
              <input
                type="text"
                className="input"
                value={newRoleDesc}
                onChange={(e) => setNewRoleDesc(e.target.value)}
                placeholder="例如: 负责网盘剧集重命名与归档整理"
                style={{ width: "100%" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", marginBottom: 4 }}>权限等级</label>
              <select
                className="input"
                value={newRoleLevel}
                onChange={(e) => setNewRoleLevel(Number(e.target.value))}
                style={{ width: "100%" }}
              >
                <option value={30}>Level 30 (高级协同)</option>
                <option value={40}>Level 40 (标准成员)</option>
                <option value={50}>Level 50 (自动化/脚本)</option>
                <option value={60}>Level 60 (受限访客)</option>
              </select>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: 8 }}>
              <button type="button" className="btn btn-secondary" onClick={() => setShowCreateModal(false)}>
                取消
              </button>
              <button type="button" className="btn btn-primary" onClick={handleCreateRole} disabled={isPending}>
                {isPending ? "正在创建…" : "确认创建"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 删除角色确认弹窗 */}
      <UserActionConfirmDialog
        spec={
          deleteConfirmRole
            ? {
                title: "删除自定义角色",
                description: `确定删除自定义角色「${deleteConfirmRole.name}」吗？\n删除后关联此角色的用户与 API Key 权限将被安全回退。`,
                confirmLabel: "确认删除",
                isDanger: true,
              }
            : null
        }
        isPending={isPending}
        onConfirm={() => {
          if (!deleteConfirmRole) return;
          const role = deleteConfirmRole;
          startTransition(async () => {
            try {
              const res = await fetch(`/api/settings/roles/${role.id}`, { method: "DELETE" });
              if (res.ok) {
                flash(`已删除角色: ${role.name}`);
                setDeleteConfirmRole(null);
                void fetchRoles();
              } else {
                const err = await res.json().catch(() => null);
                flash(err?.error || "删除失败", true);
              }
            } catch (e) {
              flash(String(e), true);
            }
          });
        }}
        onCancel={() => setDeleteConfirmRole(null)}
      />
    </section>
  );
}
