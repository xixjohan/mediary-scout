import { connection } from "next/server";
import { isMultiUserEnabled, hasLoginPassword, getCurrentAccountSummary } from "../../../lib/workflow-runtime";
import { AccountIdentity } from "./account-identity";

/**
 * Async server loader for the sidebar identity block.
 * Supports both multi-user instances and single-user instances with password configured.
 * Mounted inside <Suspense> so its DB read never blocks the static sidebar shell.
 */
export async function AccountIdentityLoader() {
  await connection();
  try {
    const summary = await getCurrentAccountSummary();
    if (!summary) return null;

    // 单用户未设密码模式下，提供友好引导身份标识，确保随时可展开个人资料与密码保护
    if (!isMultiUserEnabled() && !(await hasLoginPassword())) {
      return (
        <AccountIdentity
          username="管理员 (未设密码)"
          isOwner={summary.isOwner}
        />
      );
    }

    return (
      <AccountIdentity
        username={summary.username === "default" ? "管理员" : summary.username}
        isOwner={summary.isOwner}
      />
    );
  } catch {
    return null;
  }
}
