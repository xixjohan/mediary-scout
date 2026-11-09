"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, AlertTriangle, LoaderCircle, X, Activity, Server, Zap, ShieldCheck } from "lucide-react";
import { diagnoseStorageConnectionAction } from "../../../app/actions/storage-drives-actions";
import type { StorageDiagnosticsReport } from "../application/drive-service";

interface StorageDiagnosticsModalProps {
  storageId: string;
  providerLabel: string;
  onClose: () => void;
}

function EngineModeBanner({
  mode,
  supportsOpenOAuth,
  providerLabel,
  authKind,
}: {
  mode?: string | undefined;
  supportsOpenOAuth: boolean;
  providerLabel: string;
  authKind: "cookie" | "token";
}) {
  if (!supportsOpenOAuth) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          background: "rgba(16, 185, 129, 0.1)",
          border: "1px solid rgba(16, 185, 129, 0.3)",
          borderRadius: 8,
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Zap size={16} style={{ color: "#10b981" }} />
            <span style={{ fontWeight: 600, fontSize: 14 }}>
              当前引擎模式：原生 {authKind === "token" ? "Token" : "Cookie"} 驱动 (稳态运行)
            </span>
          </div>
          <p style={{ margin: "4px 0 0 24px", fontSize: 12, color: "#a1a1aa" }}>
            专为 {providerLabel} 原生协议定制，提供稳态影视转存、目录索引与媒体直链解析。
          </p>
        </div>
      </div>
    );
  }

  const isDual = mode === "dual_engine";
  const isOpen = mode === "open_only";
  const title = isDual
    ? "双轨融合 (Dual-Engine Hybrid) [最佳生产状态]"
    : isOpen
    ? "仅开放平台 (Open-Only)"
    : "传统 Cookie (Cookie-Only)";

  const desc = isDual
    ? "转存操作自动走 Cookie 轨，扫库大清单与直链播放走官方 Open API，异常时自动毫秒级降级回退。"
    : "建议升级配置 OAuth 或 Cookie 开启双轨，实现扫库免掉线与转存全功能支持。";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 16px",
        background: isDual ? "rgba(16, 185, 129, 0.1)" : "rgba(245, 158, 11, 0.1)",
        border: `1px solid ${isDual ? "rgba(16, 185, 129, 0.3)" : "rgba(245, 158, 11, 0.3)"}`,
        borderRadius: 8,
      }}
    >
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Zap size={16} style={{ color: isDual ? "#10b981" : "#f59e0b" }} />
          <span style={{ fontWeight: 600, fontSize: 14 }}>当前引擎模式：{title}</span>
        </div>
        <p style={{ margin: "4px 0 0 24px", fontSize: 12, color: "#a1a1aa" }}>{desc}</p>
      </div>
    </div>
  );
}

function CookieTrackCard({
  cookieStatus,
  authKind,
}: {
  cookieStatus: StorageDiagnosticsReport["cookieStatus"];
  authKind?: "cookie" | "token";
}) {
  return (
    <div style={{ padding: 14, background: "rgba(255, 255, 255, 0.03)", borderRadius: 8, border: "1px solid rgba(255, 255, 255, 0.08)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
          <Server size={14} style={{ color: "#38bdf8" }} />
          {authKind === "token" ? "Token 凭据轨 (API)" : "Cookie 基础轨 (转存)"}
        </span>
        {cookieStatus.valid ? (
          <span style={{ color: "#10b981", fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
            <CheckCircle2 size={13} /> 正常
          </span>
        ) : (
          <span style={{ color: "#ef4444", fontSize: 12 }}>异常</span>
        )}
      </div>
      <div style={{ fontSize: 12, color: "#a1a1aa", lineHeight: 1.6 }}>
        <div>凭据配置：{cookieStatus.configured ? "已绑定" : "未绑定"}</div>
        <div>探活延迟：{cookieStatus.latencyMs !== undefined ? `${cookieStatus.latencyMs} ms` : "-"}</div>
        {cookieStatus.error ? (
          <div style={{ color: "#ef4444", marginTop: 4 }}>错误: {cookieStatus.error}</div>
        ) : null}
      </div>
    </div>
  );
}

function formatOAuthTtl(sec?: number): { text: string; isExpired: boolean } {
  if (sec === undefined) return { text: "-", isExpired: false };
  if (sec > 0) {
    const days = Math.floor(sec / 86400);
    return { text: days > 0 ? `${days} 天 (${sec}s)` : `${sec} 秒`, isExpired: false };
  }
  const overdueHours = Math.abs(Math.floor(sec / 3600));
  const desc = overdueHours > 0 ? `${overdueHours} 小时前` : "刚刚";
  return { text: `已过期 (${desc}，需重新授权)`, isExpired: true };
}

function OpenOAuthStatusBadge({ isHealthy, isConfigured }: { isHealthy: boolean; isConfigured: boolean }) {
  if (isHealthy) {
    return (
      <span style={{ color: "#10b981", fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
        <CheckCircle2 size={13} /> 正常
      </span>
    );
  }
  if (isConfigured) {
    return (
      <span style={{ color: "#ef4444", fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
        <AlertTriangle size={13} /> 授权失效
      </span>
    );
  }
  return <span style={{ color: "#71717a", fontSize: 12 }}>未配置</span>;
}

function OpenOAuthStatusSummary({ isHealthy, isConfigured }: { isHealthy: boolean; isConfigured: boolean }) {
  if (!isConfigured) {
    return <span style={{ color: "#71717a" }}>未配置</span>;
  }
  return (
    <span style={{ color: isHealthy ? "#10b981" : "#f59e0b" }}>
      {isHealthy ? "已授权" : "已授权 (当前凭据不可用)"}
    </span>
  );
}

function OpenOAuthTrackCard({ openOAuthStatus }: { openOAuthStatus: StorageDiagnosticsReport["openOAuthStatus"] }) {
  const isHealthy = Boolean(openOAuthStatus?.valid);
  const isConfigured = Boolean(openOAuthStatus?.configured);
  const { text: ttlText, isExpired } = formatOAuthTtl(openOAuthStatus?.expiresInSec);

  return (
    <div style={{ padding: 14, background: "rgba(255, 255, 255, 0.03)", borderRadius: 8, border: "1px solid rgba(255, 255, 255, 0.08)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
          <ShieldCheck size={14} style={{ color: isHealthy ? "#10b981" : isConfigured ? "#ef4444" : "#a1a1aa" }} />
          Open OAuth 轨 (清单/直链)
        </span>
        <OpenOAuthStatusBadge isHealthy={isHealthy} isConfigured={isConfigured} />
      </div>
      <div style={{ fontSize: 12, color: "#a1a1aa", lineHeight: 1.6 }}>
        <div>OAuth 状态：<OpenOAuthStatusSummary isHealthy={isHealthy} isConfigured={isConfigured} /></div>
        <div>API 延迟：{openOAuthStatus?.latencyMs !== undefined ? `${openOAuthStatus.latencyMs} ms` : "-"}</div>
        <div>
          令牌剩余 TTL：
          <span style={{ color: isExpired ? "#ef4444" : "inherit" }}>{ttlText}</span>
        </div>
        {openOAuthStatus?.error ? (
          <div style={{ color: "#ef4444", marginTop: 4, wordBreak: "break-all" }}>
            错误: {openOAuthStatus.error}
          </div>
        ) : null}
        {isConfigured && !isHealthy ? (
          <div style={{ marginTop: 8, fontSize: 11, color: "#f59e0b", background: "rgba(245, 158, 11, 0.08)", padding: "6px 8px", borderRadius: 4, lineHeight: 1.4 }}>
            提示：Refresh Token 已被官方注销或过期，请前往「设置 → 添加网盘 → 115网盘 → 开放OAuth」重新扫码授权。
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RoutingSummaryCard({
  routing,
  supportsOpenOAuth,
}: {
  routing: StorageDiagnosticsReport["routingSummary"];
  supportsOpenOAuth: boolean;
}) {
  if (!supportsOpenOAuth) {
    const isTransferOk = routing.transferEngine === "cookie";
    return (
      <div style={{ padding: 14, background: "rgba(255, 255, 255, 0.02)", borderRadius: 8, border: "1px dashed rgba(255, 255, 255, 0.1)" }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "#e4e4e7" }}>
          策略路由派发实况 (Strategy Dispatch)
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#a1a1aa" }}>
          <span>影视转存 (receiveShare):</span>
          <span style={{ color: isTransferOk ? "#10b981" : "#ef4444", fontWeight: 500 }}>
            {isTransferOk ? "原生协议转存" : "无可用通道"}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#a1a1aa", marginTop: 4 }}>
          <span>媒体库扫库 (listItems):</span>
          <span style={{ color: "#10b981", fontWeight: 500 }}>原生目录检索</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#a1a1aa", marginTop: 4 }}>
          <span>STRM 直链与串流 (resolveStream):</span>
          <span style={{ color: "#10b981", fontWeight: 500 }}>原生直链解析</span>
        </div>
      </div>
    );
  }

  const isTransferOk = routing.transferEngine === "cookie";
  const isOpenListing = routing.listingEngine === "open";
  const isOpenStream = routing.streamEngine === "open";

  return (
    <div style={{ padding: 14, background: "rgba(255, 255, 255, 0.02)", borderRadius: 8, border: "1px dashed rgba(255, 255, 255, 0.1)" }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "#e4e4e7" }}>
        策略路由派发实况 (Strategy Dispatch)
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#a1a1aa" }}>
        <span>影视转存 (receiveShare):</span>
        <span style={{ color: isTransferOk ? "#10b981" : "#ef4444", fontWeight: 500 }}>
          {isTransferOk ? "锁定 Cookie 轨" : "无可用通道"}
        </span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#a1a1aa", marginTop: 4 }}>
        <span>媒体库扫库 (listItems):</span>
        <span style={{ color: isOpenListing ? "#10b981" : "#f59e0b", fontWeight: 500 }}>
          {isOpenListing ? "Open API 1000条/次大清单" : "Cookie 单次30~50条 (降级/限流保护)"}
        </span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#a1a1aa", marginTop: 4 }}>
        <span>STRM 直链与串流 (resolveStream):</span>
        <span style={{ color: isOpenStream ? "#10b981" : "#f59e0b", fontWeight: 500 }}>
          {isOpenStream ? "Open API 原生直链 (带UA/高并发)" : "Cookie 逆向解密直链 (1.2s漏桶防护)"}
        </span>
      </div>
    </div>
  );
}

function DiagnosisReportView({
  report,
  providerLabel,
}: {
  report: StorageDiagnosticsReport;
  providerLabel: string;
}) {
  const isDual = report.supportsOpenOAuth;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <EngineModeBanner
        mode={report.engineMode}
        supportsOpenOAuth={report.supportsOpenOAuth}
        providerLabel={providerLabel}
        authKind={report.authKind}
      />
      <div style={{ display: "grid", gridTemplateColumns: isDual ? "1fr 1fr" : "1fr", gap: 12 }}>
        <CookieTrackCard cookieStatus={report.cookieStatus} authKind={report.authKind} />
        {isDual ? <OpenOAuthTrackCard openOAuthStatus={report.openOAuthStatus} /> : null}
      </div>
      <RoutingSummaryCard routing={report.routingSummary} supportsOpenOAuth={report.supportsOpenOAuth} />
    </div>
  );
}

export function StorageDiagnosticsModal({
  storageId,
  providerLabel,
  onClose,
}: StorageDiagnosticsModalProps) {
  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState<StorageDiagnosticsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  async function runDiagnosis() {
    setLoading(true);
    setError(null);
    try {
      const res = await diagnoseStorageConnectionAction(storageId);
      if (!res.ok || !res.report) {
        setError(res.error || "诊断请求失败");
      } else {
        setReport(res.report);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void runDiagnosis();
  }, [storageId]);

  const modalTitle = report?.supportsOpenOAuth
    ? `${providerLabel} · 双轨驱动诊断仪`
    : `${providerLabel} · 驱动链路诊断仪`;

  if (!mounted) return null;

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.7)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: 16,
      }}
    >
      <div
        className="panel"
        style={{
          width: "100%",
          maxWidth: 620,
          background: "#18181b",
          border: "1px solid rgba(255, 255, 255, 0.12)",
          borderRadius: 12,
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.5)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Activity size={18} style={{ color: "#10b981" }} />
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              {modalTitle}
            </h3>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={onClose}
            style={{ padding: 4, borderRadius: 6 }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: 20 }}>
          {loading ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 0", gap: 12 }}>
              <LoaderCircle size={28} className="spin" style={{ color: "#10b981" }} />
              <p style={{ margin: 0, color: "#a1a1aa", fontSize: 14 }}>正在实时探活驱动链路与测试延迟…</p>
            </div>
          ) : error ? (
            <div style={{ padding: "16px", background: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.2)", borderRadius: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#ef4444", marginBottom: 6 }}>
                <AlertTriangle size={16} />
                <span style={{ fontWeight: 600 }}>诊断探针异常</span>
              </div>
              <p style={{ margin: 0, fontSize: 13, color: "#fca5a5" }}>{error}</p>
            </div>
          ) : report ? (
            <DiagnosisReportView report={report} providerLabel={providerLabel} />
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            padding: "14px 20px",
            background: "rgba(255, 255, 255, 0.02)",
            borderTop: "1px solid rgba(255, 255, 255, 0.08)",
          }}
        >
          <button
            type="button"
            className="secondary-button"
            onClick={() => void runDiagnosis()}
            disabled={loading}
          >
            {loading ? "诊断中…" : "重新检测"}
          </button>
          <button type="button" className="primary-button" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
