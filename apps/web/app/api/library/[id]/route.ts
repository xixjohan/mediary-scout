import { NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../lib/workflow-runtime";
import { isDemoMode } from "../../../../lib/demo-mode";
import type { MediaLibraryType, LibraryDeliveryMode } from "@media-track/contracts";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  const { id } = await params;
  const repo = getWorkflowRepository();
  const library = repo.mediaLibraryStore.getLibrary(id);
  if (!library) {
    return NextResponse.json({ error: "影视库不存在" }, { status: 404 });
  }

  const bindings = repo.mediaLibraryStore.listPathBindings(id);
  return NextResponse.json({ library, bindings });
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示模式下禁止修改" }, { status: 403 });
  }

  const { id } = await params;
  const body = (await request.json().catch(() => null)) as {
    name?: string;
    libraryType?: MediaLibraryType;
    posterStyle?: "poster" | "backdrop";
    defaultDeliveryMode?: LibraryDeliveryMode;
    isPinned?: boolean;
    sortOrder?: number;
  } | null;

  if (!body) {
    return NextResponse.json({ error: "无效的请求参数" }, { status: 400 });
  }

  const repo = getWorkflowRepository();
  // 严格防篡改：忽略前端传入的 libraryType，确保影视库分类创建后不可修改
  const updated = repo.mediaLibraryStore.updateLibrary(id, {
    ...(body.name !== undefined ? { name: body.name.trim() } : {}),
    ...(body.posterStyle !== undefined ? { posterStyle: body.posterStyle } : {}),
    ...(body.defaultDeliveryMode !== undefined ? { defaultDeliveryMode: body.defaultDeliveryMode } : {}),
    ...(body.isPinned !== undefined ? { isPinned: body.isPinned } : {}),
    ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
  });

  if (!updated) {
    return NextResponse.json({ error: "影视库不存在" }, { status: 404 });
  }

  return NextResponse.json({ library: updated });
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示模式下禁止删除" }, { status: 403 });
  }

  const { id } = await params;
  const repo = getWorkflowRepository();
  const ok = repo.mediaLibraryStore.deleteLibrary(id);
  return NextResponse.json({ success: ok });
}
