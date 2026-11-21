"use client";

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronUp,
  KeyRound,
  Shield,
  Sparkles,
  X,
} from "lucide-react";
import {
  ApiKeyPermissionPreset,
  type ApiKeyPermissionModule,
  type ApiKeyV2Entity,
  type PermissionStrategyType,
} from "@media-track/shared";

export type ApiKeySafeItem = Omit<ApiKeyV2Entity, "keyHash"> & {
  hasExpired?: boolean;
};

export interface EditApiKeyModalProps {
  apiKey: ApiKeySafeItem;
  catalog: ApiKeyPermissionModule[];
  onClose: () => void;
  onSuccess: (updated: ApiKeySafeItem) => void;
}

export function EditApiKeyModal({
  apiKey,
  catalog,
  onClose,
  onSuccess,
}: EditApiKeyModalProps) {
  const [name, setName] = useState(apiKey.name);
  const [expiresOption, setExpiresOption] = useState<string>("keep");
  const [allowApi, setAllowApi] = useState(apiKey.allowApi !== false);
  const [allowMcp, setAllowMcp] = useState(apiKey.allowMcp !== false);
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>(
    apiKey.permissions || []
  );
  const [expandedModules, setExpandedModules] = useState<Record<string, boolean>>({
    media: true,
    storage: true,
    workflow: true,
    assistant: true,
    system: true,
    strm: true,
    mediaserver: true,
    extensions: true,
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
    if (!name.trim()) {
      setError("请输入 API Key 名称");
      return;
    }
    if (!allowApi && !allowMcp) {
      setError("必须至少启用 REST API 或 MCP 协议中的一个访问通道");
      return;
    }

    startTransition(async () => {
      setError(null);
      try {
        let nextExpiresAt: number | null | undefined = undefined;
        if (expiresOption === "keep") {
          nextExpiresAt = apiKey.expiresAt;
        } else if (expiresOption === "never") {
          nextExpiresAt = null;
        } else {
          const days = parseInt(expiresOption, 10);
          nextExpiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
        }

        const res = await fetch(`/api/settings/api-keys/${apiKey.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            permissions: selectedPermissions,
            allowApi,
            allowMcp,
            expiresAt: nextExpiresAt,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => null);
          throw new Error(err?.error || "更新 API Key 失败");
        }

        const data = await res.json();
        onSuccess(data.entity);
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  if (!mounted) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0,0,0,0.75)",
        backdropFilter: "blur(4px)",
        padding: "1rem",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="card"
        style={{
          width: "100%",
          maxWidth: "760px",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
          padding: "1.5rem",
          backgroundColor: "var(--bg-surface)",
          borderRadius: "0.75rem",
          boxShadow: "0 20px 25px -5px rgba(0,0,0,0.5)",
          overflow: "hidden",
        }}
      >
        {/* 标题栏 */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <KeyRound size={20} style={{ color: "var(--accent)" }} />
            <h3 style={{ margin: 0, fontSize: "1.2rem", fontWeight: 600 }}>编辑 API Key 授权</h3>
          </div>
          <button
            type="button"
            className="btn btn-icon btn-ghost"
            onClick={onClose}
            aria-label="关闭编辑窗口"
          >
            <X size={18} />
          </button>
        </div>

        {/* 凭据信息提示条 */}
        <div
          style={{
            padding: "0.75rem 1rem",
            borderRadius: "0.5rem",
            backgroundColor: "rgba(255,255,255,0.04)",
            border: "1px solid var(--border-subtle)",
            fontSize: "0.85rem",
            color: "var(--text-muted)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>
            目标凭据: <strong style={{ color: "var(--text)" }}>{apiKey.maskedKey}</strong>
          </span>
          <span style={{ fontSize: "0.75rem", color: "var(--accent)" }}>
            ⚡ 密钥保持不变 · 客户端免重新配置
          </span>
        </div>

        {error && (
          <div
            style={{
              padding: "0.75rem 1rem",
              borderRadius: "0.5rem",
              backgroundColor: "rgba(239, 68, 68, 0.15)",
              color: "#ef4444",
              fontSize: "0.875rem",
            }}
          >
            {error}
          </div>
        )}

        {/* 表单滚动容器 */}
        <div
          style={{
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: "1.25rem",
            paddingRight: "0.5rem",
          }}
        >
          {/* Key 名称 */}
          <div>
            <label
              style={{ display: "block", marginBottom: "0.4rem", fontSize: "0.875rem", fontWeight: 500 }}
            >
              Key 名称
            </label>
            <input
              type="text"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如: Cursor AI Agent / 自动化同步脚本"
              style={{ width: "100%" }}
            />
          </div>

          {/* 有效期续期设置 */}
          <div>
            <label
              style={{ display: "block", marginBottom: "0.4rem", fontSize: "0.875rem", fontWeight: 500 }}
            >
              有效期调整
            </label>
            <select
              className="input"
              value={expiresOption}
              onChange={(e) => setExpiresOption(e.target.value)}
              style={{ width: "100%" }}
            >
              <option value="keep">保持现有有效期不变</option>
              <option value="7">延长至 7 天后</option>
              <option value="30">延长至 30 天后 (推荐)</option>
              <option value="90">延长至 90 天后</option>
              <option value="never">永久有效 (无到期时间)</option>
            </select>
          </div>

          {/* 访问通道 Scope */}
          <div>
            <label
              style={{ display: "block", marginBottom: "0.4rem", fontSize: "0.875rem", fontWeight: 500 }}
            >
              协议通道权限 (Channel Scope)
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "0.5rem",
                  padding: "0.6rem 0.8rem",
                  borderRadius: "0.5rem",
                  border: "1px solid var(--border-subtle)",
                  backgroundColor: allowApi ? "rgba(16, 185, 129, 0.08)" : "transparent",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={allowApi}
                  onChange={(e) => setAllowApi(e.target.checked)}
                  style={{ marginTop: "0.2rem" }}
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>REST API 访问</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                    允许调用 <code>/api/*</code> 标准 HTTP REST 接口
                  </div>
                </div>
              </label>

              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "0.5rem",
                  padding: "0.6rem 0.8rem",
                  borderRadius: "0.5rem",
                  border: "1px solid var(--border-subtle)",
                  backgroundColor: allowMcp ? "rgba(16, 185, 129, 0.08)" : "transparent",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={allowMcp}
                  onChange={(e) => setAllowMcp(e.target.checked)}
                  style={{ marginTop: "0.2rem" }}
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>MCP 协议服务</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                    允许接入 AI Agent (Cursor, Claude, Cline)
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* 快速策略预设 */}
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "0.4rem",
              }}
            >
              <span style={{ fontSize: "0.875rem", fontWeight: 500 }}>快速策略预设</span>
              <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                已选 {selectedPermissions.length} 项能力
              </span>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => handleApplyStrategy("safe_automation")}
              >
                <Sparkles size={14} /> 安全自动化 (推荐)
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => handleApplyStrategy("readonly")}
              >
                只读模式
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => handleApplyStrategy("full")}
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

          {/* 权限目录树 */}
          <div>
            <label
              style={{ display: "block", marginBottom: "0.5rem", fontSize: "0.875rem", fontWeight: 500 }}
            >
              功能模块与细粒度权限勾选
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {catalog.map((module) => {
                const isExpanded = !!expandedModules[module.id];
                const moduleState = ApiKeyPermissionPreset.calculateModuleState(
                  module,
                  new Set(selectedPermissions)
                );

                return (
                  <div
                    key={module.id}
                    style={{
                      border: "1px solid var(--border-subtle)",
                      borderRadius: "0.5rem",
                      overflow: "hidden",
                    }}
                  >
                    {/* 模块标题行 */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "0.6rem 0.8rem",
                        backgroundColor: "rgba(255,255,255,0.02)",
                        borderBottom: isExpanded ? "1px solid var(--border-subtle)" : "none",
                      }}
                    >
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.5rem",
                          cursor: "pointer",
                          fontWeight: 600,
                          fontSize: "0.9rem",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={moduleState === "checked"}
                          ref={(el) => {
                            if (el) el.indeterminate = moduleState === "indeterminate";
                          }}
                          onChange={() => handleToggleModule(module)}
                        />
                        <span>{module.name}</span>
                        <span style={{ color: "var(--text-muted)", fontSize: "0.8rem", fontWeight: 400 }}>
                          ({module.description})
                        </span>
                      </label>

                      <button
                        type="button"
                        className="btn btn-icon btn-ghost btn-sm"
                        onClick={() => toggleModuleAccordion(module.id)}
                        aria-label={isExpanded ? "收起模块" : "展开模块"}
                      >
                        {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                      </button>
                    </div>

                    {/* 叶子节点清单 */}
                    {isExpanded && (
                      <div
                        style={{
                          padding: "0.6rem 0.8rem",
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.5rem",
                          backgroundColor: "rgba(0,0,0,0.15)",
                        }}
                      >
                        {module.leaves.map((leaf) => {
                          const isChecked = selectedPermissions.includes(leaf.id);
                          const isAllowed = leaf.isAllowed !== false;

                          return (
                            <label
                              key={leaf.id}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                padding: "0.4rem 0.6rem",
                                borderRadius: "0.375rem",
                                backgroundColor: isChecked ? "rgba(16, 185, 129, 0.05)" : "transparent",
                                opacity: isAllowed ? 1 : 0.45,
                                cursor: isAllowed ? "pointer" : "not-allowed",
                              }}
                            >
                              <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                                <input
                                  type="checkbox"
                                  checked={isChecked}
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
        </div>

        {/* 弹窗底部操作 */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "0.5rem" }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={isPending}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={isPending || !name.trim()}
            onClick={handleSubmit}
          >
            {isPending ? "保存中..." : "保存修改"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
