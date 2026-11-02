import { connection } from "next/server";
import { hasLoginPassword, getCurrentAccountSummary } from "../../../lib/workflow-runtime";
import { AccountIdentity } from "./account-identity";

/**
 * Async server loader for the sidebar identity block.
 * Mounted inside <Suspense> so its DB read never blocks the static sidebar shell.
 */
export async function AccountIdentityLoader({ storageId }: { storageId?: string | undefined } = {}) {
  await connection();
  try {
    const summary = await getCurrentAccountSummary();
    if (!summary) return null;

    // 未设密码模式下，提供友好引导身份标识，确保随时可展开个人资料与密码保护
    if (!(await hasLoginPassword())) {
      return (
        <AccountIdentity
          username="管理员 (未设密码)"
          isOwner={summary.isOwner}
          storageId={storageId}
        />
      );
    }

    return (
      <AccountIdentity
        username={summary.username}
        isOwner={summary.isOwner}
        storageId={storageId}
      />
    );
  } catch {
    return null;
  }
}
