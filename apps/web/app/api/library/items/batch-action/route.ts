import { NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../../lib/workflow-runtime";
import { isDemoMode } from "../../../../../lib/demo-mode";

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示模式下禁止修改" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    itemIds?: string[];
    action?: "accept" | "delete";
  } | null;

  if (!body || !Array.isArray(body.itemIds) || body.itemIds.length === 0 || !body.action) {
    return NextResponse.json({ error: "参数不完整" }, { status: 400 });
  }

  const repo = getWorkflowRepository();

  if (body.action === "accept") {
    const updatedCount = repo.mediaLibraryStore.batchUpdateReviewStatus(body.itemIds, "auto_accepted");
    return NextResponse.json({ success: true, count: updatedCount });
  } else if (body.action === "delete") {
    const deletedCount = repo.mediaLibraryStore.batchDeleteMediaItems(body.itemIds);
    return NextResponse.json({ success: true, count: deletedCount });
  }

  return NextResponse.json({ error: "不支持的操作" }, { status: 400 });
}
