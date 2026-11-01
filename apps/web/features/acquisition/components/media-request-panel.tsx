"use client";

import { useEffect, useState, useTransition } from "react";
import { Check, Clock, Film, RefreshCw, XCircle, AlertCircle, CheckCircle2 } from "lucide-react";
import type { MediaRequest, MediaRequestStatus } from "@media-track/workflow";

const STATUS_MAP: Record<MediaRequestStatus, { label: string; tone: string }> = {
  pending_approval: { label: "待审批", tone: "badge-warning" },
  queued: { label: "排队中", tone: "badge-info" },
  acquiring: { label: "正在获取", tone: "badge-info" },
  ready: { label: "已入库", tone: "badge-success" },
  rejected: { label: "已拒绝", tone: "badge-error" },
  failed: { label: "获取失败", tone: "badge-error" },
};

export function MediaRequestPanel() {
  const [requests, setRequests] = useState<MediaRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [isPending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ text: string; isError?: boolean } | null>(null);

  const fetchRequests = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/media-requests?all=1", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as MediaRequest[];
        setRequests(data);
      }
    } catch {
      // 容错保持现有状态
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchRequests();
  }, []);

  const handleUpdateStatus = (id: string, status: MediaRequestStatus, reason?: string) => {
    startTransition(async () => {
      try {
        const res = await fetch("/api/media-requests", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, status, rejectionReason: reason }),
        });
        if (res.ok) {
          setMsg({ text: "状态已成功更新" });
          void fetchRequests();
        } else {
          const err = await res.json().catch(() => null);
          setMsg({ text: err?.error || "操作失败", isError: true });
        }
      } catch (e) {
        setMsg({ text: String(e), isError: true });
      }
      setTimeout(() => setMsg(null), 3000);
    });
  };

  if (!loading && requests.length === 0) {
    return null; // 无点播请求时静默折叠，不打扰单人使用
  }

  return (
    <section className="panel" style={{ marginTop: 24, maxWidth: 860 }}>
      <div className="panel-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 className="panel-title">
            <Film size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            多用户点播与求片清单 (Media Requests)
          </h2>
          <p className="panel-note">共用存储模式下家庭成员与协作成员的媒体获取请求流</p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void fetchRequests()}
          disabled={loading || isPending}
          style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
        >
          <RefreshCw size={12} className={loading ? "spin" : ""} />
          刷新
        </button>
      </div>

      {msg && (
        <div
          className={`notice ${msg.isError ? "is-error" : "is-success"}`}
          style={{ margin: "0.75rem 0", fontSize: "0.85rem" }}
        >
          {msg.isError ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}
          <span>{msg.text}</span>
        </div>
      )}

      <div style={{ display: "grid", gap: "0.6rem", marginTop: "1rem" }}>
        {requests.map((req) => {
          const meta = STATUS_MAP[req.status] || { label: req.status, tone: "badge" };
          return (
            <div
              key={req.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "0.75rem 1rem",
                borderRadius: "8px",
                background: "var(--bg-card)",
                border: "1px solid var(--border-subtle)",
                flexWrap: "wrap",
                gap: "0.5rem",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                <Film size={18} style={{ color: "var(--accent)" }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: "0.9rem", color: "var(--text)" }}>
                    {req.mediaTitleId}
                    {req.seasonNumber != null && (
                      <span style={{ marginLeft: "6px", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                        第 {req.seasonNumber} 季
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "2px" }}>
                    申请人: <code>{req.accountId}</code> · 时间: {new Date(req.createdAt).toLocaleString("zh-CN")}
                    {req.rejectionReason && ` · 拒绝原因: ${req.rejectionReason}`}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                <span className={`badge ${meta.tone}`} style={{ fontSize: "0.75rem" }}>
                  {meta.label}
                </span>

                {req.status === "pending_approval" && (
                  <>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => handleUpdateStatus(req.id, "queued")}
                      disabled={isPending}
                      style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", padding: "2px 8px", fontSize: "0.75rem" }}
                    >
                      <Check size={12} /> 批准
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        const reason = prompt("请输入拒绝理由 (可选):");
                        if (reason !== null) handleUpdateStatus(req.id, "rejected", reason);
                      }}
                      disabled={isPending}
                      style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", padding: "2px 8px", fontSize: "0.75rem" }}
                    >
                      <XCircle size={12} /> 拒绝
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
