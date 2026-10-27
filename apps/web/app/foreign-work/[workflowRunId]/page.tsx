import { Suspense } from "react";
import { PageLoginGuard } from "../../../lib/page-auth-guard";
import Link from "next/link";
import { connection } from "next/server";
import { ArrowLeft, Film, TriangleAlert } from "lucide-react";
import { AppSidebar } from "../../../components/app-sidebar";
import { GitHubNameplate } from "../../../components/github-nameplate";
import { ForeignWorkImportForm } from "../../../components/foreign-work-import-form";
import { getForeignWorkReview } from "../../../lib/workflow-runtime";

function ForeignWorkPageInner({
  params,
}: {
  params: Promise<{ workflowRunId: string }>;
}) {
  return (
    <div className="app-shell">
      <AppSidebar active="notifications" />
      <main className="main product-main">
        <Link
          className="nav-item"
          href="/notifications"
          style={{ display: "inline-flex", marginBottom: 16 }}
        >
          <ArrowLeft size={16} aria-hidden />
          返回通知
        </Link>
        <Suspense fallback={<div className="skeleton skeleton-heading" />}>
          <ForeignWorkReview params={params} />
        </Suspense>
        <GitHubNameplate />
      </main>
    </div>
  );
}

async function ForeignWorkReview({ params }: { params: Promise<{ workflowRunId: string }> }) {
  await connection();
  const { workflowRunId } = await params;
  const review = await getForeignWorkReview(decodeURIComponent(workflowRunId));

  if (!review || review.findings.length === 0) {
    return (
      <div className="quiet-state">
        <TriangleAlert size={24} aria-hidden />
        <strong>没有待处理的异作品文件</strong>
        <span>这次运行没有记录需要人工确认的文件。</span>
      </div>
    );
  }

  return (
    <section className="library-surface">
      <div className="section-heading library-heading">
        <div>
          <h1>疑似其他作品</h1>
          <p>{review.titleName} 的资源包携带了以下文件；确认名称后可单独入库为电影。</p>
        </div>
      </div>
      {review.findings.map((finding, index) => (
        <article className="panel" key={`${finding.stagingDirectoryId}_${index}`}>
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                <Film size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
                隔离区 {finding.stagingDirectoryId}
              </h2>
              <p className="panel-note">{finding.files.length} 个文件，确认前不会被移动或删除</p>
            </div>
          </div>
          <ul className="foreign-file-list">
            {finding.files.map((file) => (
              <li key={file.providerFileId}>
                <code>{file.sourcePath}</code>
              </li>
            ))}
          </ul>
          <ForeignWorkImportForm
            providerFileIds={finding.files.map((file) => file.providerFileId)}
          />
        </article>
      ))}
    </section>
  );
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
export default function ForeignWorkPage(props: Parameters<typeof ForeignWorkPageInner>[0]) {
  return (
    <>
      <Suspense fallback={null}>
        <PageLoginGuard />
      </Suspense>
      <ForeignWorkPageInner {...props} />
    </>
  );
}
