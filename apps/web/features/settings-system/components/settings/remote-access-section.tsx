import { connection } from "next/server";
import Link from "next/link";
import { Globe, KeyRound, ShieldAlert, TriangleAlert, Users } from "lucide-react";
import { getCurrentAccountSummary, hasLoginPassword, isMultiUserEnabled } from "../../../../lib/workflow-runtime";
import {
  resolveInstanceTunnelToken,
  resolveInstanceConnectHostname,
  resolveRemoteAccessState,
  passwordSetupHref,
  formatLastSeen,
  CONNECT_SITE_URL,
  consoleUrl,
} from "../../../../lib/remote-access";
import { RemoteAccessTestButton } from "./remote-access-test-button";
import { ConnectWizard, type ConnectWizardPending } from "./connect-wizard";
import { connectAccountAction } from "../../../../app/connect-actions";
import { tunnelIdFromToken } from "../../../../lib/connect-tunnel";
import { getConnectAccountEmail, getConnectInstanceCredential, getConnectLinkPending, getConnectPendingOrder } from "../../../../lib/connect-link-store";
import { FrpTunnelManagerView } from "../frp-tunnel-manager-view";

function LastSeenLine({ label }: { label: string }) {
  return (
    <p className="panel-note" style={{ margin: "6px 0 0", opacity: 0.85 }}>
      本机上次向控制面报到：{label}
    </p>
  );
}

function PasswordWarningBanner({ passwordHref }: { passwordHref: string }) {
  return (
    <div className="banner banner-warn" style={{ margin: 0 }}>
      <TriangleAlert size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 6 }} />
      <span>
        当前未设置登录密码。开启远程访问后，
        任何知道你域名的人都能直接进入，读取整个媒体库、网盘凭据与 LLM Key。请立即设置密码。
      </span>
      <a href={passwordHref} style={{ marginLeft: 8, textDecoration: "underline" }}>
        去设置密码 →
      </a>
    </div>
  );
}

function LegacyCloudflareTunnelDetails(props: {
  showAddressRow: boolean;
  tunnelAddress: string;
  lastSeenLabel: string | null;
  children: React.ReactNode;
}) {
  return (
    <details
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "8px",
        padding: "1rem 1.25rem",
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          fontWeight: 600,
          fontSize: "0.95rem",
          color: "var(--text)",
          outline: "none",
        }}
      >
        Cloudflare 托管隧道 (Mediary Connect 备用接入向导)
      </summary>

      <div style={{ marginTop: "1rem" }}>
        {props.showAddressRow && (
          <div className="push-form" style={{ marginBottom: "1rem" }}>
            <div className="setting-row">
              <span className="setting-label">隧道地址</span>
              <span className="setting-value">{props.tunnelAddress}</span>
            </div>
            {props.lastSeenLabel && <LastSeenLine label={props.lastSeenLabel} />}
            <div style={{ marginTop: 10 }}>
              <RemoteAccessTestButton />
            </div>
          </div>
        )}
        {props.children}
      </div>
    </details>
  );
}

export async function RemoteAccessSection({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  await connection();
  const me = await getCurrentAccountSummary();
  if (!me?.isOwner) return null;

  const { w } = await searchParams;
  const passwordHref = passwordSetupHref({ multiUser: isMultiUserEnabled(), w });
  const accountRead = connectAccountAction().catch(() => null);
  const localHostname = await resolveInstanceConnectHostname();
  const localToken = await resolveInstanceTunnelToken();
  const boundTunnelId = tunnelIdFromToken(localToken);
  const state = await resolveRemoteAccessState({
    token: localToken,
    hostname: localHostname,
  });

  const pendingRaw = await getConnectLinkPending();
  const pending: ConnectWizardPending | null = pendingRaw
    ? { email: pendingRaw.email, verifyCode: pendingRaw.verifyCode, expiresAt: pendingRaw.expiresAt }
    : null;
  const accountResult = await accountRead;
  const connectAccount = accountResult?.state === "linked" ? accountResult.account : null;
  const linked = (await getConnectInstanceCredential()) !== null;
  const linkedEmail = await getConnectAccountEmail();
  const pendingOrder = linked ? await getConnectPendingOrder() : null;
  const passwordState = await hasLoginPassword();
  const lastSeenLabel = state.kind === "active" ? formatLastSeen(state.lastSeenAt) : null;
  const tunnelAddress = ("hostname" in state ? state.hostname : null) || localHostname || "已配置";
  const showAddressRow = state.kind !== "not_provisioned" && Boolean(localToken);

  return (
    <div style={{ maxWidth: 760, display: "grid", gap: "1.5rem" }}>
      {passwordState === false ? (
        <PasswordWarningBanner passwordHref={passwordHref} />
      ) : null}

      {/* 现代主方案：ProxyByCF FRP 轻量反向穿透控制中心 */}
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">
              <Globe size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
              远程访问与反向穿透 (ProxyByCF FRP)
            </h2>
          </div>
          <span className="hub-badge tone-green">推荐 · 零上行</span>
        </div>
        <FrpTunnelManagerView />
      </section>

      {/* 备用托管方案：Mediary Connect (Cloudflare Tunnel 托管通道) */}
      <LegacyCloudflareTunnelDetails
        showAddressRow={showAddressRow}
        tunnelAddress={tunnelAddress}
        lastSeenLabel={lastSeenLabel}
      >
        <ConnectWizard
          compact
          linked={linked}
          email={linkedEmail}
          pending={pending}
          account={connectAccount}
          hasTunnelToken={Boolean(localToken)}
          boundHostname={localHostname}
          boundTunnelId={boundTunnelId}
          passwordSet={passwordState}
          multiUser={isMultiUserEnabled()}
          pendingOrder={pendingOrder}
        />
      </LegacyCloudflareTunnelDetails>

      <section className="panel" style={{ padding: "1.25rem" }}>
        <p className="panel-note" style={{ margin: "0 0 4px", fontWeight: 600, color: "var(--text)" }}>
          远程访问统一安全机制 (Unified Identity Security)
        </p>
        <p className="panel-note" style={{ margin: "0 0 12px" }}>
          远程访问已完全接入系统的统一用户体系。通过反向穿透或公网专属地址访问时，所有访客均使用各自的用户账号及密码登录，享受独立媒体库与 RBAC 权限隔离。
        </p>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <Link
            href="/settings?tab=account#accounts"
            className="btn btn-secondary btn-sm"
            style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
          >
            <Users size={14} aria-hidden />
            管理系统用户
          </Link>
          <Link
            href="/settings?tab=account#password"
            className="btn btn-secondary btn-sm"
            style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
          >
            <KeyRound size={14} aria-hidden />
            修改个人登录密码
          </Link>
        </div>
      </section>
    </div>
  );
}
