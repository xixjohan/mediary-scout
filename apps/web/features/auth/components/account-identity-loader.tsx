import { connection } from "next/server";
import { getCurrentAccountSummary } from "../../../lib/workflow-runtime";
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
