import { NextResponse, type NextRequest } from "next/server";
import { getWorkflowRepository } from "../../../../../../lib/workflow-runtime";
import {
  ensureStorageStreamResolver,
  ensureStrmTaskConfigRegistry,
  getStrmSingleFlight,
} from "../../../../../../composition/runtime-container";

interface RouteParams {
  params: Promise<{ taskId: string; fileId: string }>;
}

const VIDEO_MIME_MAP: Record<string, string> = {
  ".mkv": "video/x-matroska",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ts": "video/mp2t",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".flv": "video/x-flv",
  ".wmv": "video/x-ms-wmv",
  ".asf": "video/x-ms-asf",
  ".rmvb": "video/vnd.rn-realvideo",
  ".iso": "application/x-iso9660-image",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
};

export function inferVideoMimeType(fileName?: string, upstreamType?: string | null): string {
  if (fileName) {
    const extMatch = fileName.match(/\.[a-zA-Z0-9]+$/);
    if (extMatch) {
      const ext = extMatch[0].toLowerCase();
      if (VIDEO_MIME_MAP[ext]) {
        return VIDEO_MIME_MAP[ext];
      }
    }
  }
  if (
    upstreamType &&
    !upstreamType.includes("octet-stream") &&
    !upstreamType.includes("force-download")
  ) {
    return upstreamType;
  }
  return "video/mp4";
}

function handleRedirect(targetUrl: string): Response {
  return NextResponse.redirect(targetUrl, {
    status: 302,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
      "Referrer-Policy": "no-referrer",
    },
  });
}

async function handleStreamProxy(
  request: NextRequest,
  targetUrl: string,
  options?: {
    customHeaders?: Record<string, string> | undefined;
    fileName?: string | undefined;
  },
): Promise<Response> {
  try {
    const clientRange = request.headers.get("range");
    const isHead = request.method === "HEAD";

    const upstreamHeaders: Record<string, string> = {
      "User-Agent":
        options?.customHeaders?.["User-Agent"] ||
        options?.customHeaders?.["user-agent"] ||
        request.headers.get("user-agent") ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      ...(options?.customHeaders || {}),
    };

    if (clientRange) {
      upstreamHeaders["Range"] = clientRange;
    }

    const upstreamResp = await fetch(targetUrl, {
      method: isHead ? "HEAD" : "GET",
      headers: upstreamHeaders,
      redirect: "follow",
      signal: request.signal,
    });

    const responseHeaders = new Headers();
    responseHeaders.set("Accept-Ranges", "bytes");
    responseHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    responseHeaders.set("Pragma", "no-cache");
    responseHeaders.set("Expires", "0");
    responseHeaders.set("Referrer-Policy", "no-referrer");

    const forwardHeaders = [
      "content-range",
      "content-length",
      "etag",
      "last-modified",
    ];

    for (const name of forwardHeaders) {
      const val = upstreamResp.headers.get(name);
      if (val) {
        responseHeaders.set(name, val);
      }
    }

    // 智能修正 Content-Type（杜绝 application/octet-stream 导致浏览器或播放器解码器退化）
    const upstreamContentType = upstreamResp.headers.get("content-type");
    responseHeaders.set("content-type", inferVideoMimeType(options?.fileName, upstreamContentType));

    // 强制输出 inline disposition，杜绝网盘上游强制 attachment 导致浏览器或播放器弹出下载对话框
    const effectiveFileName = options?.fileName || "video.mkv";
    const asciiSafe = effectiveFileName.replace(/[^\x20-\x7E]/g, "_");
    const encodedUtf8 = encodeURIComponent(effectiveFileName);
    responseHeaders.set(
      "content-disposition",
      `inline; filename="${asciiSafe}"; filename*=UTF-8''${encodedUtf8}`,
    );

    if (isHead || !upstreamResp.body) {
      return new Response(null, {
        status: upstreamResp.status,
        headers: responseHeaders,
      });
    }

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: responseHeaders,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `上游流媒体代理转发失败: ${message}` },
      { status: 502 },
    );
  }
}

export async function GET(request: NextRequest, context: RouteParams) {
  const { taskId, fileId } = await context.params;
  const fileName = request.nextUrl.searchParams.get("name") ?? undefined;
  const pickCode = request.nextUrl.searchParams.get("pickCode") ?? undefined;

  // 1. 纯内存字典 O(1) 检索 STRM 任务交付配置（带 SingleFlight 防并发击穿与物理特性协商）
  const registry = ensureStrmTaskConfigRegistry();
  let config;
  try {
    config = await registry.resolveConfig(taskId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `STRM 任务配置解析失败: ${message}` },
      { status: 404 },
    );
  }

  // 2. 状态机防护：若任务已被用户暂停或未启用，直接 403 熔断
  if (!config.isActive) {
    return NextResponse.json(
      { error: `STRM 同步任务 [${taskId}] 已暂停或未启用，拒绝串流。` },
      { status: 403 },
    );
  }

  const { storageId, deliveryMode } = config;
  const cacheKey = `${storageId}:${fileId}`;
  const repo = getWorkflowRepository();

  // 3. Link Cache 快速查询（带 TTL 检查，防 mock 污染）
  const cached = await repo.getStrmLinkCache(cacheKey);
  const isMockCached = cached?.downloadUrl?.includes("mock-cdn.cloudpan.com");
  if (cached && !isMockCached) {
    const headers = cached.headersJson
      ? (JSON.parse(cached.headersJson) as Record<string, string>)
      : undefined;
    if (deliveryMode === "proxy") {
      return handleStreamProxy(request, cached.downloadUrl, {
        customHeaders: headers,
        fileName,
      });
    }
    return handleRedirect(cached.downloadUrl);
  }

  // 4. SingleFlight 请求合并（防止 Infuse/Plex 播放器并发 Range 请求击穿网盘 API）
  const singleFlight = getStrmSingleFlight();
  const resolver = ensureStorageStreamResolver();
  try {
    const stream = await singleFlight.do(cacheKey, async () => {
      const doubleCheck = await repo.getStrmLinkCache(cacheKey);
      if (doubleCheck && !doubleCheck.downloadUrl.includes("mock-cdn.cloudpan.com")) {
        return {
          url: doubleCheck.downloadUrl,
          deliveryMode: doubleCheck.deliveryMode,
          ...(doubleCheck.headersJson
            ? { headers: JSON.parse(doubleCheck.headersJson) as Record<string, string> }
            : {}),
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
        deliveryMode: deliveryMode,
        headersJson: resolved.headers ? JSON.stringify(resolved.headers) : null,
        expiresAt: Math.floor(Date.now() / 1000) + resolved.expirationSeconds,
      });

      return resolved;
    });

    if (deliveryMode === "proxy") {
      return handleStreamProxy(request, stream.url, {
        customHeaders: stream.headers,
        fileName,
      });
    }

    return handleRedirect(stream.url);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `流媒体解析失败: ${message}` },
      { status: 502 },
    );
  }
}

export async function HEAD(request: NextRequest, context: RouteParams) {
  return GET(request, context);
}
