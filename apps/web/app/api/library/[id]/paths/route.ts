import { NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../../lib/workflow-runtime";
import { isDemoMode } from "../../../../../lib/demo-mode";
import type { BindingDeliveryMode, LibraryScanMode } from "@media-track/contracts";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  const { id } = await params;
  const repo = getWorkflowRepository();
  const bindings = repo.mediaLibraryStore.listPathBindings(id);
  return NextResponse.json({ bindings });
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示模式下禁止修改" }, { status: 403 });
  }

  const { id } = await params;
  const body = (await request.json().catch(() => null)) as {
    storageId?: string;
    remoteFolderId?: string;
    remotePath?: string;
    scheduledScanEnabled?: boolean;
    scanIntervalMinutes?: number;
    scanCron?: string;
    scanMode?: LibraryScanMode;
    minFileSizeMb?: number;
    excludeKeywords?: string[];
    deliveryMode?: BindingDeliveryMode;
  } | null;

  if (!body || !body.storageId || !body.remoteFolderId) {
    return NextResponse.json({ error: "必须指定网盘驱动与目标目录" }, { status: 400 });
  }

  const repo = getWorkflowRepository();
  const binding = repo.mediaLibraryStore.createPathBinding({
    libraryId: id,
    storageId: body.storageId.trim(),
    remoteFolderId: body.remoteFolderId.trim(),
    remotePath: body.remotePath?.trim() || "/",
    ...(body.scheduledScanEnabled !== undefined ? { scheduledScanEnabled: body.scheduledScanEnabled } : {}),
    ...(body.scanIntervalMinutes !== undefined ? { scanIntervalMinutes: Number(body.scanIntervalMinutes) } : {}),
    ...(body.scanCron !== undefined ? { scanCron: body.scanCron } : {}),
    ...(body.scanMode !== undefined ? { scanMode: body.scanMode } : {}),
    ...(body.minFileSizeMb !== undefined ? { minFileSizeMb: Number(body.minFileSizeMb) } : {}),
    ...(body.excludeKeywords !== undefined ? { excludeKeywords: body.excludeKeywords } : {}),
    ...(body.deliveryMode !== undefined ? { deliveryMode: body.deliveryMode } : {}),
  });

  return NextResponse.json({ binding });
}

export async function PUT(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示模式下禁止修改" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    bindingId?: string;
    scheduledScanEnabled?: boolean;
    scanIntervalMinutes?: number;
    scanCron?: string;
    scanMode?: LibraryScanMode;
    minFileSizeMb?: number;
    excludeKeywords?: string[];
    deliveryMode?: BindingDeliveryMode;
  } | null;

  if (!body || !body.bindingId) {
    return NextResponse.json({ error: "缺少 bindingId" }, { status: 400 });
  }

  const repo = getWorkflowRepository();
  const updated = repo.mediaLibraryStore.updatePathBinding(body.bindingId, {
    ...(body.scheduledScanEnabled !== undefined ? { scheduledScanEnabled: body.scheduledScanEnabled } : {}),
    ...(body.scanIntervalMinutes !== undefined ? { scanIntervalMinutes: Number(body.scanIntervalMinutes) } : {}),
    ...(body.scanCron !== undefined ? { scanCron: body.scanCron } : {}),
    ...(body.scanMode !== undefined ? { scanMode: body.scanMode } : {}),
    ...(body.minFileSizeMb !== undefined ? { minFileSizeMb: Number(body.minFileSizeMb) } : {}),
    ...(body.excludeKeywords !== undefined ? { excludeKeywords: body.excludeKeywords } : {}),
    ...(body.deliveryMode !== undefined ? { deliveryMode: body.deliveryMode } : {}),
  });

  if (!updated) {
    return NextResponse.json({ error: "绑定的路径不存在" }, { status: 404 });
  }

  return NextResponse.json({ binding: updated });
}

export async function DELETE(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  if (isDemoMode()) {
    return NextResponse.json({ error: "演示模式下禁止修改" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const bindingId = searchParams.get("bindingId");
  if (!bindingId) {
    return NextResponse.json({ error: "缺少 bindingId" }, { status: 400 });
  }

  const repo = getWorkflowRepository();
  const result = repo.mediaLibraryStore.deletePathBinding(bindingId);
  return NextResponse.json(result);
}
