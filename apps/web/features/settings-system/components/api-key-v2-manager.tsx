"use client";

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  KeyRound,
  Plus,
  Shield,
  Trash2,
} from "lucide-react";
import {
  PERMISSION_CATALOG,
  type ApiKeyPermissionModule,
  type ApiKeyV2Entity,
} from "@media-track/shared";
import { CreateApiKeyModal } from "./create-api-key-modal";
import { UserActionConfirmDialog } from "./user-action-confirm-dialog";

interface ApiKeySafeItem extends Omit<ApiKeyV2Entity, "keyHash"> {
  hasExpired?: boolean;
}

export function ApiKeyV2Manager() {
  const [keys, setKeys] = useState<ApiKeySafeItem[]>([]);
  const [catalog, setCatalog] = useState<ApiKeyPermissionModule[]>(PERMISSION_CATALOG);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // 弹窗状态
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [revealedKeyName, setRevealedKeyName] = useState<string>("");
  const [copied, setCopied] = useState(false);

  const [mounted, setMounted] = useState(false);
  const [deleteConfirmKey, setDeleteConfirmKey] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const [isPending, startTransition] = useTransition();

  const flashMessage = (msg: string, isError = false) => {
    if (isError) {
      setErrorMessage(msg);
      setTimeout(() => setErrorMessage(null), 5000);
    } else {
      setSuccessMessage(msg);
      setTimeout(() => setSuccessMessage(null), 4000);
    }
  };

  const fetchKeys = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings/api-keys");
      if (res.ok) {
        const data = await res.json();
        setKeys(data);
      } else {
        const err = await res.json().catch(() => null);
        flashMessage(err?.error || "加载 API Key 列表失败", true);
      }
    } catch (e) {
      flashMessage(String(e), true);
    } finally {
      setLoading(false);
    }
  };

  const fetchCatalog = async () => {
    try {
      const res = await fetch("/api/settings/api-keys/available-permissions");
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.catalog) && data.catalog.length > 0) {
          setCatalog(data.catalog);
        }
      }
    } catch {
      // 降级使用本地引入的 PERMISSION_CATALOG
    }
  };

  useEffect(() => {
    void fetchKeys();
    void fetchCatalog();
  }, []);

  const handleDeleteKey = (id: string, name: string) => {
    setDeleteConfirmKey({ id, name });
  };

  const copyToClipboard = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="api-key-v2-container">
      {/* 提示消息 */}
      {errorMessage && (
        <div className="notice is-error" style={{ marginBottom: "1rem" }}>
          <AlertTriangle size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          {errorMessage}
        </div>
      )}
      {successMessage && (
        <div className="notice is-success" style={{ marginBottom: "1rem" }}>
          <Check size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          {successMessage}
        </div>
      )}

      {/* 顶部操作区 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <div>
          <p className="panel-note" style={{ margin: 0 }}>
            用于外部自动化脚本、第三方下载器及 AI Agent (如 Cursor / Antigravity) 细粒度授权访问本实例。
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setShowCreateModal(true)}
          style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
        >
          <Plus size={15} /> 新建 API Key
        </button>
      </div>

      {/* 密钥列表表格 */}
      {loading ? (
        <div className="skeleton" style={{ height: 120, borderRadius: 8 }} />
      ) : keys.length === 0 ? (
        <div className="panel" style={{ textAlign: "center", padding: "2rem", color: "var(--text-muted)" }}>
          <KeyRound size={32} style={{ opacity: 0.3, marginBottom: "0.5rem" }} />
          <p style={{ margin: 0 }}>暂无生效中的授权 API Key，点击右上角新建。</p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {keys.map((k) => {
            const isExpired = k.expiresAt !== null && k.expiresAt < Date.now();
            const isExpiringSoon =
              !isExpired && k.expiresAt !== null && k.expiresAt - Date.now() < 7 * 24 * 60 * 60 * 1000;

            return (
              <div
                key={k.id}
                style={{
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "8px",
                  padding: "0.85rem 1.1rem",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "1rem",
                }}
              >
                <div style={{ display: "grid", gap: "0.3rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                    <strong style={{ fontSize: "0.95rem" }}>{k.name}</strong>
                    <code
                      style={{
                        fontSize: "0.8rem",
                        background: "var(--bg-hover)",
                        padding: "0.15rem 0.4rem",
                        borderRadius: "4px",
                        fontFamily: "monospace",
                      }}
                    >
                      {k.maskedKey}
                    </code>
                    {isExpired ? (
                      <span className="badge is-error" style={{ fontSize: "0.75rem" }}>已过期</span>
                    ) : isExpiringSoon ? (
                      <span className="badge is-warn" style={{ fontSize: "0.75rem" }}>即将到期</span>
                    ) : (
                      <span className="badge is-on" style={{ fontSize: "0.75rem" }}>生效中</span>
                    )}
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "1rem", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                      <Shield size={13} />
                      授权能力: {k.permissions.length} 项 (
                      {k.permissions.length === 0
                        ? "无权限"
                        : k.permissions.length > 3
                          ? `${k.permissions.slice(0, 3).join(", ")}...`
                          : k.permissions.join(", ")}
                      )
                    </span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                      <Clock size={13} />
                      {k.expiresAt ? `有效期至 ${new Date(k.expiresAt).toLocaleDateString()}` : "永久有效"}
                    </span>
                    {k.lastUsedAt && (
                      <span>最后活跃: {new Date(k.lastUsedAt).toLocaleDateString()}</span>
                    )}
                  </div>
                </div>

                <div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={isPending}
                    onClick={() => handleDeleteKey(k.id, k.name)}
                    style={{ color: "var(--color-danger, #ef4444)" }}
                    title="吊销/删除 Key"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 弹窗：创建新 API Key */}
      {showCreateModal && (
        <CreateApiKeyModal
          catalog={catalog}
          onClose={() => setShowCreateModal(false)}
          onSuccess={(plainTextKey, keyName) => {
            setShowCreateModal(false);
            setRevealedKey(plainTextKey);
            setRevealedKeyName(keyName);
            void fetchKeys();
          }}
        />
      )}

      {/* 弹窗：一次性明文揭示弹窗 */}
      {revealedKey && mounted &&
        createPortal(
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.75)",
              backdropFilter: "blur(6px)",
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
                padding: "1.75rem",
                width: "100%",
                maxWidth: "560px",
              }}
            >
              <div style={{ textAlign: "center", marginBottom: "1.25rem" }}>
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: "50%",
                    background: "var(--bg-hover)",
                    color: "var(--accent)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    marginBottom: "0.75rem",
                  }}
                >
                  <KeyRound size={24} />
                </div>
                <h3 style={{ margin: "0 0 0.4rem", fontSize: "1.25rem", fontWeight: 600 }}>API Key 已就绪</h3>
                <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--text-muted)" }}>
                  名称: <strong>{revealedKeyName}</strong>
                </p>
              </div>

              <div
                className="notice is-warn"
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "0.5rem",
                  fontSize: "0.85rem",
                  marginBottom: "1rem",
                }}
              >
                <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                <div>
                  <strong>请立即复制并妥善保存此 Key！</strong>
                  出于安全考虑，离开此窗口后，完整密钥将不再显示（数据库仅保留加盐哈希值）。
                </div>
              </div>

              <div
                style={{
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "8px",
                  padding: "0.75rem 1rem",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "0.5rem",
                  marginBottom: "1.5rem",
                }}
              >
                <code style={{ fontSize: "0.95rem", wordBreak: "break-all", fontFamily: "monospace" }}>
                  {revealedKey}
                </code>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => copyToClipboard(revealedKey)}
                  style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? "已复制" : "复制"}
                </button>
              </div>

              <button
                type="button"
                className="btn btn-primary"
                style={{ width: "100%" }}
                onClick={() => {
                  setRevealedKey(null);
                  setCopied(false);
                }}
              >
                我已复制并妥善保存
              </button>
            </div>
          </div>,
          document.body
        )}

      {/* 吊销 Key 确认弹窗 */}
      <UserActionConfirmDialog
        spec={
          deleteConfirmKey
            ? {
                title: "吊销 API Key",
                description: `确认吊销/删除 API Key「${deleteConfirmKey.name}」吗？\n外部客户端、AI Agent 或第三方脚本使用此 Key 的请求将立即被系统拦截拒绝。`,
                confirmLabel: "确认吊销",
                isDanger: true,
              }
            : null
        }
        isPending={isPending}
        onConfirm={() => {
          if (!deleteConfirmKey) return;
          const { id, name } = deleteConfirmKey;
          startTransition(async () => {
            try {
              const res = await fetch(`/api/settings/api-keys/${id}`, {
                method: "DELETE",
              });
              if (res.ok) {
                flashMessage(`已成功吊销 API Key: ${name}`);
                setDeleteConfirmKey(null);
                void fetchKeys();
              } else {
                const data = await res.json().catch(() => null);
                flashMessage(data?.error || "删除失败", true);
              }
            } catch (err) {
              flashMessage(String(err), true);
            }
          });
        }}
        onCancel={() => setDeleteConfirmKey(null)}
      />
    </div>
  );
}
