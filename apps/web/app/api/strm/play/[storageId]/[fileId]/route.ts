import { NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../../../lib/workflow-runtime";
import { getStrmSingleFlight } from "../../../../../../composition/runtime-container";
import { getStorageStreamResolver } from "@media-track/workflow";

interface RouteParams {
  params: Promise<{ storageId: string; fileId: string }>;
}

export async function GET(request: NextRequest, context: RouteParams) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;

  const { storageId, fileId } = await context.params;
  const fileName = request.nextUrl.searchParams.get("name") ?? undefined;
  const pickCode = request.nextUrl.searchParams.get("pickCode") ?? undefined;
  const repo = getWorkflowRepository();
  const cacheKey = `${storageId}:${fileId}`;

  // 1. Link Cache 快速查询（带 TTL 检查）
  const cached = await repo.getStrmLinkCache(cacheKey);
  if (cached) {
    return NextResponse.redirect(cached.downloadUrl, {
      status: 302,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
      },
    });
  }

  // 2. SingleFlight 请求合并（防止 Infuse/Plex 播放器并发 Range 请求击穿网盘 API）
  const singleFlight = getStrmSingleFlight();
  const resolver = getStorageStreamResolver();
  const stream = await singleFlight.do(cacheKey, async () => {
    const doubleCheck = await repo.getStrmLinkCache(cacheKey);
    if (doubleCheck) {
      return {
        url: doubleCheck.downloadUrl,
        deliveryMode: "redirect" as const,
        expirationSeconds: 7200,
      };
    }

    const resolved = await resolver.resolveStream({
      storageId,
      fileId,
      ...(fileName !== undefined ? { fileName } : {}),
      ...(pickCode !== undefined ? { pickCode } : {}),
      ...(request.headers.get("user-agent")
        ? { userAgent: request.headers.get("user-agent")! }
        : {}),
    });

    await repo.setStrmLinkCache({
      cacheKey,
      downloadUrl: resolved.url,
      deliveryMode: resolved.deliveryMode,
      headersJson: resolved.headers ? JSON.stringify(resolved.headers) : null,
      expiresAt: Math.floor(Date.now() / 1000) + resolved.expirationSeconds,
    });

    return resolved;
  });

  return NextResponse.redirect(stream.url, {
    status: 302,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
    },
  });
}

export async function HEAD(request: NextRequest, context: RouteParams) {
  return GET(request, context);
}
