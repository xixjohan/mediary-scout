import { Suspense } from "react";
import { connection } from "next/server";
import { PageLoginGuard } from "../../lib/page-auth-guard";
import { ClientLoginRedirect } from "../../features/auth/components/client-login-redirect";
import { AppSidebar } from "../../components/layout/app-sidebar";
import { ChatWorkspace } from "../../features/assistant/components/chat-workspace";
import { GitHubNameplate } from "../../components/layout/github-nameplate";
import { getCurrentAccountId, resolveGlobalWorkspace, UNAUTHENTICATED_ACCOUNT_ID } from "../../lib/workflow-runtime";

function ChatPageInner({
  searchParams,
}: {
  searchParams: Promise<{ w?: string; c?: string }>;
}) {
  return (
    <Suspense fallback={<ChatShell />}>
      <ChatSurface searchParams={searchParams} />
    </Suspense>
  );
}

function ChatShell() {
  return (
    <div className="app-shell">
      <AppSidebar active="chat" skeleton />
      <main className="main product-main" aria-busy="true" />
    </div>
  );
}

async function ChatSurface({
  searchParams,
}: {
  searchParams: Promise<{ w?: string; c?: string }>;
}) {
  await connection();
  const accountId = await getCurrentAccountId();
  if (accountId === UNAUTHENTICATED_ACCOUNT_ID) {
    return (
      <>
        <ClientLoginRedirect />
        <ChatShell />
      </>
    );
  }
  const { w, c } = await searchParams;
  const workspace = await resolveGlobalWorkspace(w);
  return (
    <div className="app-shell">
      <AppSidebar
        active="chat"
        basePath={workspace.basePath}
        activeStorageId={workspace.activeStorageId}
      />
      <main className="main product-main product-main-chat">
        <ChatWorkspace
          storageId={workspace.activeStorageId}
          initialConversationId={c}
        />
        <GitHubNameplate />
      </main>
    </div>
  );
}

export default function ChatPage(props: Parameters<typeof ChatPageInner>[0]) {
  return (
    <>
      <Suspense fallback={null}>
        <PageLoginGuard />
      </Suspense>
      <ChatPageInner {...props} />
    </>
  );
}
