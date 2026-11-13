import { NextResponse, type NextRequest } from "next/server";
import {
  verifyStrmPlayToken,
  determineEffectiveDeliveryMode,
  buildStrmLinkCacheKey,
} from "@media-track/workflow";
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
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function buildUpstreamHeaders(
  request: NextRequest,
  options?: { customHeaders?: Record<string, string> | undefined },
): Record<string, string> {
  const clientRange = request.headers.get("range");
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
  return upstreamHeaders;
}

function buildProxyResponseHeaders(
  upstreamResp: Response,
  fileName?: string | undefined,
): Headers {
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
  responseHeaders.set("content-type", inferVideoMimeType(fileName, upstreamContentType));

  // 强制输出 inline disposition，杜绝网盘上游强制 attachment 导致浏览器或播放器弹出下载对话框
  const effectiveFileName = fileName || "video.mkv";
  const asciiSafe = effectiveFileName.replace(/[^\x20-\x7E]/g, "_");
  const encodedUtf8 = encodeURIComponent(effectiveFileName);
  responseHeaders.set(
    "content-disposition",
    `inline; filename="${asciiSafe}"; filename*=UTF-8''${encodedUtf8}`,
  );

  // 跨域 CORS 支持：保障 Web Audio API 软增益与现代浏览器无障碍读取媒体流
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  responseHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type, Accept, Origin");
  responseHeaders.set(
    "Access-Control-Expose-Headers",
    "Content-Range, Content-Length, Accept-Ranges, Content-Type, Content-Disposition",
  );

  return responseHeaders;
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
    const isHead = request.method === "HEAD";
    const upstreamHeaders = buildUpstreamHeaders(request, options);

    const upstreamResp = await fetch(targetUrl, {
      method: isHead ? "HEAD" : "GET",
      headers: upstreamHeaders,
      redirect: "follow",
      signal: request.signal,
    });

    const responseHeaders = buildProxyResponseHeaders(upstreamResp, options?.fileName);

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

function validatePlayToken(
  taskId: string,
  fileId: string,
  token: string | null,
  exp: number | null,
): NextResponse | null {
  if (token || exp) {
    const verification = verifyStrmPlayToken({
      taskId,
      fileId,
      token,
      expiresAtEpochSeconds: exp,
    });
    if (!verification.valid) {
      return NextResponse.json(
        { error: `STRM 播放签名鉴权失败: ${verification.reason === "token_expired" ? "播放令牌已过期" : "签名无效"}` },
        { status: 401 },
      );
    }
    return null;
  }
  if (process.env.STRM_AUTH_STRICT === "true") {
    return NextResponse.json(
      { error: "STRM 播放请求必须携带签名令牌 (缺少 token 与 exp 参数)" },
      { status: 401 },
    );
  }
  return null;
}

async function serveStream(
  request: NextRequest,
  url: string,
  deliveryMode: string,
  headers?: Record<string, string>,
  fileName?: string,
): Promise<Response> {
  if (deliveryMode === "proxy") {
    return handleStreamProxy(request, url, {
      customHeaders: headers,
      fileName,
    });
  }
  return handleRedirect(url);
}

async function resolveTaskConfig(taskId: string) {
  try {
    const config = await ensureStrmTaskConfigRegistry().resolveConfig(taskId);
    if (!config.isActive) {
      return {
        error: NextResponse.json(
          { error: `STRM 任务或存储驱动 [${taskId}] 已暂停或处于冻结状态，拒绝串流。` },
          { status: 403 },
        ),
      };
    }
    return { config };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: NextResponse.json(
        { error: `STRM 任务或存储配置解析失败: ${message}` },
        { status: 404 },
      ),
    };
  }
}

async function resolveAndCacheStream(options: {
  repo: ReturnType<typeof getWorkflowRepository>;
  resolver: ReturnType<typeof ensureStorageStreamResolver>;
  storageId: string;
  fileId: string;
  cacheKey: string;
  deliveryMode: "proxy" | "redirect";
  fileName?: string | undefined;
  pickCode?: string | undefined;
  userAgent?: string | null | undefined;
}) {
  const { repo, resolver, storageId, fileId, cacheKey, deliveryMode, fileName, pickCode, userAgent } = options;
  const doubleCheck = await repo.getStrmLinkCache(cacheKey);
  if (doubleCheck && !doubleCheck.downloadUrl.includes("mock-cdn.cloudpan.com")) {
    const headers = doubleCheck.headersJson ? (JSON.parse(doubleCheck.headersJson) as Record<string, string>) : undefined;
    return {
      url: doubleCheck.downloadUrl,
      deliveryMode,
      ...(headers ? { headers } : {}),
      expirationSeconds: 7200,
    };
  }

  // 若为 proxy 模式，拉流由服务端统一代理完成，向上游网盘发起时使用标准桌面浏览器 UA；
  // 若为 redirect 模式，则将客户端真实 UA 传给网盘以生成匹配签名的直链
  const resolverUa =
    deliveryMode === "proxy"
      ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
      : (userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");

  const resolved = await resolver.resolveStream({
    storageId,
    fileId,
    ...(fileName !== undefined ? { fileName } : {}),
    ...(pickCode !== undefined ? { pickCode } : {}),
    userAgent: resolverUa,
  });

  const effectiveHeaders: Record<string, string> = {
    ...(resolved.headers || {}),
    "User-Agent": resolverUa,
  };

  await repo.setStrmLinkCache({
    cacheKey,
    downloadUrl: resolved.url,
    deliveryMode,
    headersJson: JSON.stringify(effectiveHeaders),
    expiresAt: Math.floor(Date.now() / 1000) + resolved.expirationSeconds,
  });

  return {
    url: resolved.url,
    deliveryMode,
    headers: effectiveHeaders,
    expirationSeconds: resolved.expirationSeconds,
  };
}

export async function GET(request: NextRequest, context: RouteParams) {
  const { taskId, fileId } = await context.params;
  const fileName = request.nextUrl.searchParams.get("name") ?? undefined;
  const pickCode = request.nextUrl.searchParams.get("pickCode") ?? undefined;
  const queryDelivery = request.nextUrl.searchParams.get("delivery");
  const token = request.nextUrl.searchParams.get("token");
  const expStr = request.nextUrl.searchParams.get("exp");
  const exp = expStr ? Number(expStr) : null;

  const authError = validatePlayToken(taskId, fileId, token, exp);
  if (authError) return authError;

  const taskResult = await resolveTaskConfig(taskId);
  if (taskResult.error) return taskResult.error;
  const config = taskResult.config;

  const { storageId } = config;
  const clientUa = request.headers.get("user-agent");

  // 若前端请求显式指定了 delivery (如 proxy 模式自愈或直连)，优先尊重请求参数
  const configuredDelivery =
    queryDelivery === "proxy" || queryDelivery === "redirect" || queryDelivery === "auto"
      ? queryDelivery
      : config.deliveryMode;

  const effectiveDelivery = determineEffectiveDeliveryMode({
    configuredMode: configuredDelivery,
    provider: config.provider,
    userAgent: clientUa,
  });

  // 多维隔离缓存键：proxy 模式统一共享，redirect 模式按 UA 分组隔离
  const cacheKey = buildStrmLinkCacheKey({
    storageId,
    fileId,
    deliveryMode: effectiveDelivery,
    userAgent: clientUa,
  });

  const repo = getWorkflowRepository();

  let cached = await repo.getStrmLinkCache(cacheKey);
  if (!cached) {
    // 降级回退兼容纯净传统键 (${storageId}:${fileId})
    cached = await repo.getStrmLinkCache(`${storageId}:${fileId}`);
  }

  if (cached && !cached.downloadUrl.includes("mock-cdn.cloudpan.com")) {
    const headers = cached.headersJson ? (JSON.parse(cached.headersJson) as Record<string, string>) : undefined;
    return serveStream(request, cached.downloadUrl, effectiveDelivery, headers, fileName);
  }

  const singleFlight = getStrmSingleFlight();
  const resolver = ensureStorageStreamResolver();
  try {
    const stream = await singleFlight.do(cacheKey, () =>
      resolveAndCacheStream({
        repo,
        resolver,
        storageId,
        fileId,
        cacheKey,
        deliveryMode: effectiveDelivery,
        fileName,
        pickCode,
        userAgent: clientUa,
      }),
    );
    return serveStream(request, stream.url, effectiveDelivery, stream.headers, fileName);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `流媒体解析失败: ${message}` }, { status: 502 });
  }
}

export async function HEAD(request: NextRequest, context: RouteParams) {
  return GET(request, context);
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range, Content-Type, Accept, Origin",
      "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, Content-Type, Content-Disposition",
      "Access-Control-Max-Age": "86400",
    },
  });
}
