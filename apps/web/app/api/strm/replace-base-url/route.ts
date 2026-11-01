import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { replaceBaseUrlInFiles } from "@media-track/workflow";

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    directoryPath?: string;
    newBaseUrl?: string;
  } | null;

  if (!body || !body.directoryPath || !body.newBaseUrl) {
    return NextResponse.json(
      { error: "directoryPath, newBaseUrl 均为必填项" },
      { status: 400 },
    );
  }

  try {
    const result = await replaceBaseUrlInFiles(
      body.directoryPath.trim(),
      body.newBaseUrl.trim(),
    );

    return NextResponse.json({
      ok: true,
      total: result.total,
      updated: result.updated,
      errors: result.errors,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
