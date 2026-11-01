"use client";

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronUp,
  Shield,
  Sparkles,
  X,
} from "lucide-react";
import {
  ApiKeyPermissionPreset,
  type ApiKeyPermissionModule,
  type PermissionStrategyType,
} from "@media-track/shared";

export function CreateApiKeyModal({
  catalog,
  onClose,
  onSuccess,
}: {
  catalog: ApiKeyPermissionModule[];
  onClose: () => void;
  onSuccess: (
    plainTextKey: string,
    keyName: string,
    permissions: string[],
    allowApi?: boolean,
    allowMcp?: boolean
  ) => void;
}) {
  const [createName, setCreateName] = useState("");
  const [createExpiresDays, setCreateExpiresDays] = useState<string>("30");
  const [allowApi, setAllowApi] = useState(true);
  const [allowMcp, setAllowMcp] = useState(true);
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>(() => {
    const leaves = ApiKeyPermissionPreset.applyStrategy("safe_automation", catalog);
    const allowed = new Set(
      catalog.flatMap((m) => m.leaves.filter((l) => l.isAllowed !== false).map((l) => l.id))
    );
    return leaves.filter((id) => allowed.has(id));
  });
  const [expandedModules, setExpandedModules] = useState<Record<string, boolean>>({
    media: true,
    storage: true,
    workflow: true,
    assistant: true,
    system: true,
  });
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  const handleApplyStrategy = (strategy: PermissionStrategyType) => {
    const leaves = ApiKeyPermissionPreset.applyStrategy(strategy, catalog);
    const allowed = new Set(
      catalog.flatMap((m) => m.leaves.filter((l) => l.isAllowed !== false).map((l) => l.id))
    );
    setSelectedPermissions(leaves.filter((id) => allowed.has(id)));
  };

  const handleToggleModule = (module: ApiKeyPermissionModule) => {
    const currentSet = new Set(selectedPermissions);
    const allowedLeaves = module.leaves.filter((l) => l.isAllowed !== false);
    const allowedIds = allowedLeaves.map((l) => l.id);
    if (allowedIds.length === 0) return;

    const allChecked = allowedIds.every((id) => currentSet.has(id));
    if (allChecked) {
      setSelectedPermissions((prev) => prev.filter((id) => !allowedIds.includes(id)));
    } else {
      setSelectedPermissions((prev) => Array.from(new Set([...prev, ...allowedIds])));
    }
  };

  const handleToggleLeaf = (leafId: string) => {
    setSelectedPermissions((prev) =>
      prev.includes(leafId) ? prev.filter((id) => id !== leafId) : [...prev, leafId]
    );
  };

  const toggleModuleAccordion = (modId: string) => {
    setExpandedModules((prev) => ({ ...prev, [modId]: !prev[modId] }));
  };

  const handleSubmit = () => {
    if (!createName.trim()) {
      setError("请输入 API Key 名称");
      return;
    }

    if (!allowApi && !allowMcp) {
      setError("请至少开启一种协议通道权限（REST API 或 MCP 服务）");
      return;
    }

    startTransition(async () => {
      try {
        let expiresAt: number | null = null;
        if (createExpiresDays !== "never") {
          const days = parseInt(createExpiresDays, 10);
          if (!isNaN(days) && days > 0) {
            expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
          }
        }

        const res = await fetch("/api/settings/api-keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: createName.trim(),
            permissions: selectedPermissions,
            expiresAt,
            allowApi,
            allowMcp,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "创建失败");
          return;
        }

        onSuccess(data.plainTextKey, createName.trim(), selectedPermissions, allowApi, allowMcp);
      } catch (err) {
        setError(String(err));
      }
    });
  };

  if (!mounted) return null;

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
    >
      <div
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: "12px",
          padding: "1.5rem",
          width: "100%",
          maxWidth: "680px",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h3 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 600 }}>新建细粒度 API Key</h3>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            style={{ padding: "0.2rem" }}
          >
            <X size={16} />
          </button>
        </div>

        {error && (
          <div className="notice is-error" style={{ marginBottom: "1rem", fontSize: "0.85rem" }}>
            {error}
          </div>
        )}

        <div style={{ display: "grid", gap: "1rem" }}>
          {/* 基本信息 */}
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "0.75rem" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.3rem" }}>Key 名称</label>
              <input
                type="text"
                className="input"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="例如: Cursor AI Agent / 自动化同步脚本"
                style={{ width: "100%" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.3rem" }}>有效期</label>
              <select
                className="input"
                value={createExpiresDays}
                onChange={(e) => setCreateExpiresDays(e.target.value)}
                style={{ width: "100%" }}
              >
                <option value="7">7 天</option>
                <option value="30">30 天 (推荐)</option>
                <option value="90">90 天</option>
                <option value="never">永久有效</option>
              </select>
            </div>
          </div>

          {/* 协议通道权限 (Channel Scope) */}
          <div
            style={{
              background: "var(--bg-hover)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "8px",
              padding: "0.75rem 1rem",
            }}
          >
            <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.4rem" }}>
              协议通道权限 (Channel Scope)
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "0.5rem",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                  padding: "0.35rem 0.5rem",
                  borderRadius: "6px",
                  background: allowApi ? "var(--bg-surface)" : "transparent",
                  border: `1px solid ${allowApi ? "var(--border)" : "transparent"}`,
                }}
              >
                <input
                  type="checkbox"
                  checked={allowApi}
                  onChange={(e) => setAllowApi(e.target.checked)}
                  style={{ marginTop: "0.2rem" }}
                />
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    <strong>REST API 访问</strong>
                    <span
                      className="badge"
                      style={{
                        fontSize: "0.7rem",
                        padding: "0.05rem 0.35rem",
                        background: "rgba(59, 130, 246, 0.15)",
                        color: "#3b82f6",
                        border: "1px solid rgba(59, 130, 246, 0.3)",
                      }}
                    >
                      HTTP API
                    </span>
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.15rem" }}>
                    允许调用 <code>/api/*</code> 标准 HTTP REST 接口 (供第三方程序、脚本自动化使用)
                  </div>
                </div>
              </label>

              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "0.5rem",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                  padding: "0.35rem 0.5rem",
                  borderRadius: "6px",
                  background: allowMcp ? "var(--bg-surface)" : "transparent",
                  border: `1px solid ${allowMcp ? "var(--border)" : "transparent"}`,
                }}
              >
                <input
                  type="checkbox"
                  checked={allowMcp}
                  onChange={(e) => setAllowMcp(e.target.checked)}
                  style={{ marginTop: "0.2rem" }}
                />
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    <strong>MCP 协议服务</strong>
                    <span
                      className="badge"
                      style={{
                        fontSize: "0.7rem",
                        padding: "0.05rem 0.35rem",
                        background: "rgba(168, 85, 247, 0.15)",
                        color: "#a855f7",
                        border: "1px solid rgba(168, 85, 247, 0.3)",
                      }}
                    >
                      Agent MCP
                    </span>
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.15rem" }}>
                    允许通过 <code>/api/mcp</code> 接入 AI Agent (Cursor, Claude, Cline, Antigravity)
                  </div>
                </div>
              </label>
            </div>
            {!allowApi && !allowMcp && (
              <div style={{ color: "var(--color-danger, #ef4444)", fontSize: "0.75rem", marginTop: "0.4rem" }}>
                ⚠️ 必须至少保留一个协议通道，否则外部客户端将无法调用任何接口。
              </div>
            )}
          </div>

          {/* 策略模式预设按钮 */}
          <div>
            <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.35rem", color: "var(--text-muted)" }}>
              快速策略预设 (Strategy Presets)
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => handleApplyStrategy("safe_automation")}
                style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
              >
                <Shield size={13} /> 安全自动化 (推荐)
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => handleApplyStrategy("readonly")}
                style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
              >
                <Sparkles size={13} /> 只读模式
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => handleApplyStrategy("full")}
                style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
              >
                完整权限 (排除高危)
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => handleApplyStrategy("clear")}
              >
                清空选择
              </button>
            </div>
          </div>

          {/* 树状权限勾选矩阵 */}
          <div>
            <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.5rem", fontWeight: 600 }}>
              权限范围 ({selectedPermissions.length} 项已选择)
            </label>
            <div style={{ display: "grid", gap: "0.6rem" }}>
              {catalog.map((module) => {
                const allowedLeaves = module.leaves.filter((l) => l.isAllowed !== false);
                const hasAllowed = allowedLeaves.length > 0;
                const checkedCount = allowedLeaves.filter((l) => selectedPermissions.includes(l.id)).length;
                const isChecked = hasAllowed && checkedCount === allowedLeaves.length;
                const isIndeterminate = checkedCount > 0 && checkedCount < allowedLeaves.length;
                const isExpanded = expandedModules[module.id] ?? true;

                return (
                  <div
                    key={module.id}
                    style={{
                      border: "1px solid var(--border-subtle)",
                      borderRadius: "8px",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        background: "var(--bg-hover)",
                        padding: "0.5rem 0.8rem",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <label
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "0.5rem",
                          cursor: hasAllowed ? "pointer" : "not-allowed",
                          opacity: hasAllowed ? 1 : 0.6,
                          fontWeight: 600,
                          fontSize: "0.9rem",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={!hasAllowed}
                          ref={(el) => {
                            if (el) el.indeterminate = isIndeterminate;
                          }}
                          onChange={() => handleToggleModule(module)}
                        />
                        {module.name}
                        <span style={{ fontSize: "0.8rem", fontWeight: "normal", color: "var(--text-muted)" }}>
                          ({module.description})
                        </span>
                      </label>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => toggleModuleAccordion(module.id)}
                        style={{ padding: "0.15rem 0.4rem", border: "none", background: "transparent" }}
                      >
                        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                    </div>

                    {isExpanded && (
                      <div style={{ padding: "0.6rem 1rem", display: "grid", gap: "0.5rem", background: "var(--bg-surface)" }}>
                        {module.leaves.map((leaf) => {
                          const isAllowed = leaf.isAllowed !== false;
                          const checked = selectedPermissions.includes(leaf.id);
                          return (
                            <label
                              key={leaf.id}
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                fontSize: "0.85rem",
                                cursor: isAllowed ? "pointer" : "not-allowed",
                                opacity: isAllowed ? 1 : 0.5,
                                padding: "0.2rem 0",
                              }}
                            >
                              <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={!isAllowed}
                                  onChange={() => isAllowed && handleToggleLeaf(leaf.id)}
                                />
                                <strong>{leaf.name}</strong>
                                <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
                                  {leaf.description}
                                </span>
                              </span>

                              <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                                {leaf.supportsMcp && (
                                  <span
                                    className="badge is-on"
                                    style={{ fontSize: "0.7rem", padding: "0.1rem 0.4rem" }}
                                    title="此权限支持通过 MCP Server 向 AI Agent 动态投影"
                                  >
                                    MCP
                                  </span>
                                )}

                                {!isAllowed && (
                                  <span
                                    className="badge is-error"
                                    style={{ fontSize: "0.7rem", padding: "0.1rem 0.4rem" }}
                                    title="超出您当前角色的权限委派边界"
                                  >
                                    超出当前角色
                                  </span>
                                )}

                                <span
                                  className={`badge ${
                                    leaf.riskLevel === "Dangerous"
                                      ? "is-error"
                                      : leaf.riskLevel === "Execute"
                                        ? "is-warn"
                                        : "is-on"
                                  }`}
                                  style={{ fontSize: "0.7rem", padding: "0.1rem 0.4rem" }}
                                >
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
          </div>

          {/* 弹窗底部操作 */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "0.5rem" }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={isPending || !createName.trim()}
              onClick={handleSubmit}
            >
              {isPending ? "创建中..." : "确认生成"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
