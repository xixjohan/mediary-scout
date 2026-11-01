import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../../../lib/settings-attention-server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getExtensionManager } from "../../../../../composition/runtime-container";
import {
  ForkSandboxRunner,
  type DynamicProviderSearchResult,
} from "@media-track/workflow";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const { id } = await context.params;
  const manager = getExtensionManager();
  const ext = await manager.getExtension(id);
  if (!ext) {
    return NextResponse.json({ error: "Extension not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as {
    keyword?: string;
    config?: Record<string, unknown>;
  } | null;

  const keyword = body?.keyword?.trim() || "测试影视";
  const entryPath = path.resolve(ext.rootDir, ext.manifest.entry);

  const result = await ForkSandboxRunner.executeMethod<DynamicProviderSearchResult>(
    entryPath,
    "search",
    { keyword, config: body?.config },
    { timeoutMs: 8000 }
  );

  return NextResponse.json(result);
}
