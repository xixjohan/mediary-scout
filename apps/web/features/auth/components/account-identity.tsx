"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { LogOut, KeyRound, Users, User } from "lucide-react";
import { useAuth } from "../hooks/use-auth";
import { UserProfileModal } from "./user-profile-modal";

/**
 * 侧边栏用户身份组件：
 * 展示当前用户头像与昵称，点击展开下拉菜单（查看个人资料、修改密码、账号管理、退出登录）。
 */
export function AccountIdentity({ username, isOwner }: { username: string; isOwner: boolean }) {
  const { logout, user } = useAuth();
  const [profileOpen, setProfileOpen] = useState(false);
  const displayName = user?.username || username;
  const initial = displayName.trim().charAt(0).toUpperCase() || "U";

  // 保持当前活跃的工作空间网盘参数 (?w)
  const searchParams = useSearchParams();
  const w = searchParams?.get("w") ?? null;
  const accountHref = (hash: string) =>
    `/settings?tab=account${w ? `&w=${encodeURIComponent(w)}` : ""}${hash}`;

  return (
    <>
      <details className="account-identity">
        <summary className="account-identity-summary">
          <span className="account-identity-dot" aria-hidden>
            {initial}
          </span>
          <span className="account-identity-name">{displayName}</span>
          {isOwner ? <span className="account-identity-owner">站主</span> : null}
        </summary>
        <div className="account-identity-menu">
          <button
            type="button"
            className="account-identity-item"
            onClick={() => setProfileOpen(true)}
            style={{ width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer" }}
          >
            <User size={14} aria-hidden />
            个人资料与权限
          </button>
          <Link className="account-identity-item" href={accountHref("#password")}>
            <KeyRound size={14} aria-hidden />
            修改密码
          </Link>
          {isOwner ? (
            <Link className="account-identity-item" href={accountHref("#accounts")}>
              <Users size={14} aria-hidden />
              账号管理
            </Link>
          ) : null}
          <button
            type="button"
            className="account-identity-item"
            onClick={() => void logout()}
            style={{ width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer" }}
          >
            <LogOut size={14} aria-hidden />
            退出登录
          </button>
        </div>
      </details>

      <UserProfileModal isOpen={profileOpen} onClose={() => setProfileOpen(false)} />
    </>
  );
}
