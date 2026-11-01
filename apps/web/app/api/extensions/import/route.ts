import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../../lib/settings-attention-server";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getExtensionManager } from "../../../../composition/runtime-container";

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const contentType = request.headers.get("content-type") || "";
  const manager = getExtensionManager();

  // 1. 如果传的是 JSON { filePath: "..." }
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as { filePath?: string } | null;
    if (!body || !body.filePath) {
      return NextResponse.json({ error: "缺少 filePath 参数" }, { status: 400 });
    }
    try {
      const ext = await manager.importFromZip(body.filePath);
      return NextResponse.json(ext, { status: 201 });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 400 }
      );
    }
  }

  // 2. 如果传的是 multipart/form-data 文件流
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "未包含上传的 zip 文件" }, { status: 400 });
    }

    const tempZipPath = path.join(
      os.tmpdir(),
      `ext_upload_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.zip`
    );
    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(tempZipPath, buffer);

    try {
      const ext = await manager.importFromZip(tempZipPath);
      return NextResponse.json(ext, { status: 201 });
    } finally {
      await fs.unlink(tempZipPath).catch(() => {});
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
