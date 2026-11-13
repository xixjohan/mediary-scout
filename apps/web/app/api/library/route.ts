import { NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../lib/workflow-runtime";
import { isDemoMode } from "../../../lib/demo-mode";
import type { MediaLibrary, MediaLibraryType, LibraryDeliveryMode } from "@media-track/contracts";

export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  const repo = getWorkflowRepository();
  const libraries = repo.mediaLibraryStore.listLibraries(accountId);

  // 附带各库的绑定路径数与媒体数
  const enriched = libraries.map((lib: MediaLibrary) => {
    const bindings = repo.mediaLibraryStore.listPathBindings(lib.id);
    const itemsCount = repo.mediaLibraryStore.listMediaItems({ libraryId: lib.id, limit: 1 }).total;
    return {
      ...lib,
      bindingsCount: bindings.length,
      itemsCount,
    };
  });

  return NextResponse.json({ libraries: enriched });
}

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  const accountId = gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示模式下禁止创建影视库" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    name?: string;
    libraryType?: MediaLibraryType;
    posterStyle?: "poster" | "backdrop";
    defaultDeliveryMode?: LibraryDeliveryMode;
  } | null;

  if (!body || !body.name || !body.name.trim()) {
    return NextResponse.json({ error: "影视库名称不能为空" }, { status: 400 });
  }

  const repo = getWorkflowRepository();
  const library = repo.mediaLibraryStore.createLibrary({
    accountId,
    name: body.name.trim(),
    ...(body.libraryType ? { libraryType: body.libraryType } : {}),
    ...(body.posterStyle ? { posterStyle: body.posterStyle } : {}),
    ...(body.defaultDeliveryMode ? { defaultDeliveryMode: body.defaultDeliveryMode } : {}),
  });

  return NextResponse.json({ library });
}
