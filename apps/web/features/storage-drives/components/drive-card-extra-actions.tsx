"use client";

import { useState } from "react";
import { Activity, KeyRound } from "lucide-react";
import { StorageDiagnosticsModal } from "./storage-diagnostics-modal";
import { StorageCredentialsModal } from "./storage-credentials-modal";

interface DriveCardExtraActionsProps {
  storageId: string;
  provider: string;
  providerLabel: string;
}

export function DriveCardExtraActions({
  storageId,
  provider,
  providerLabel,
}: DriveCardExtraActionsProps) {
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showCredentials, setShowCredentials] = useState(false);

  return (
    <>
      <button
        type="button"
        className="ghost-button"
        onClick={() => setShowDiagnostics(true)}
        title={provider === "pan115" ? "查看双轨链路延迟与策略路由诊断" : "查看驱动链路延迟与运行状态诊断"}
        style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
      >
        <Activity size={13} style={{ color: "#10b981" }} />
        <span>诊断</span>
      </button>

      <button
        type="button"
        className="ghost-button"
        onClick={() => setShowCredentials(true)}
        title="零信任安全查看与复制已登录网盘凭据 (Cookie / OAuth)"
        style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
      >
        <KeyRound size={13} style={{ color: "#f59e0b" }} />
        <span>凭据</span>
      </button>

      {showDiagnostics ? (
        <StorageDiagnosticsModal
          storageId={storageId}
          providerLabel={providerLabel}
          onClose={() => setShowDiagnostics(false)}
        />
      ) : null}

      {showCredentials ? (
        <StorageCredentialsModal
          storageId={storageId}
          providerLabel={providerLabel}
          onClose={() => setShowCredentials(false)}
        />
      ) : null}
    </>
  );
}
