import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../../../lib/settings-attention-server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getExtensionManager } from "../../../../../composition/runtime-container";
import { ExtensionMementoEditor } from "@media-track/workflow";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteParams) {
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

  const file = request.nextUrl.searchParams.get("file") || ext.manifest.entry;
  try {
    const content = await ExtensionMementoEditor.readCode(ext.rootDir, file);
    return NextResponse.json({ file, content });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 404 }
    );
  }
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
    file?: string;
    content?: string;
  } | null;

  if (!body || !body.file || typeof body.content !== "string") {
    return NextResponse.json({ error: "缺少 file 或 content 参数" }, { status: 400 });
  }

  try {
    const result = await ExtensionMementoEditor.saveCode(ext.rootDir, body.file, body.content);
    return NextResponse.json({ ok: true, file: body.file, snapshotId: result.snapshotId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
