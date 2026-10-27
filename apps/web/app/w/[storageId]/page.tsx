import { Suspense } from "react";
import { PageLoginGuard } from "../../../lib/page-auth-guard";
import { notFound } from "next/navigation";
import { WorkspaceNotFoundError } from "@media-track/workflow";
import { HomeView } from "../../page";
import { getActiveWorkspaceScope } from "../../../lib/workflow-runtime";

/**
 * Tree model: a specific drive's workspace. Same home surface as the root route,
 * scoped to this connected storage. Root ("/") is the account's PRIMARY drive;
 * additional drives live here. A storageId the account does not own → 404.
 *
 * All dynamic reads (params + the ownership-validating DB call) live INSIDE a
 * Suspense boundary so the static shell still prerenders — cacheComponents
 * forbids uncached data access outside <Suspense> (the "blocking-route" error).
 */
function WorkspaceHomePageInner({
  params,
  searchParams,
}: {
  params: Promise<{ storageId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<div className="app-shell" />}>
      <ValidatedWorkspaceHome params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function ValidatedWorkspaceHome({
  params,
  searchParams,
}: {
  params: Promise<{ storageId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>> | undefined;
}) {
  const { storageId } = await params;
  try {
    // Up-front ownership validation; the data readers re-resolve the same scope.
    await getActiveWorkspaceScope(storageId);
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) {
      notFound();
    }
    throw error;
  }
  return <HomeView searchParams={searchParams} storageId={storageId} />;
}

/**
 * S5.7 页面登录守卫（见 lib/page-auth-guard.ts）。
 *
 * 为什么每页都要包一层：cacheComponents（PPR）下，请求期读取必须发生在
 * <Suspense> 边界内，否则构建期预渲染直接失败；而 layout 顶层读又被同一规则
 * 挡下（S5.7 两条路都实测过）。页面级是唯一同时满足「构建能过」与「redirect
 * 能生效」的位置——redirect 在 streaming 下插 meta 标签让客户端跳转，且 React
 * 会在该边界抛出时中止渲染，原页面的数据不会进入 HTML（已实测确认）。
 */
export default function WorkspaceHomePage(props: Parameters<typeof WorkspaceHomePageInner>[0]) {
  return (
    <>
      <Suspense fallback={null}>
        <PageLoginGuard />
      </Suspense>
      <WorkspaceHomePageInner {...props} />
    </>
  );
}
