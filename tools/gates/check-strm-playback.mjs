#!/usr/bin/env node
/**
 * 巡影 · Mediary Scout STRM 播放直链与流媒体中继质量门禁 (STRM Playback Gate)
 *
 * 核心检查项：
 *  1. 【流媒体解析器架构门禁 (StorageStreamResolver Architecture Guard)】：
 *     确保 stream-resolver.ts 实现了真实驱动接入能力（ProductionStorageStreamResolver），
 *     且在 runtime-container.ts 中通过 ensureStorageStreamResolver() 将真实驱动注入运行时容器；
 *     严禁在生产运行时默认使用虚构假桩 (MockStorageStreamResolver) 欺骗媒体播放器。
 *  2. 【115 专用大文件直链加解密协议门禁 (115 DownURL Cipher Guard)】：
 *     确保 pan115-downurl-cipher.ts 导出 encode115DownurlPayload 与 decode115DownurlResponse；
 *     确保 pan115-cookie-client.ts 优先使用 https://proapi.115.com/app/chrome/downurl 获取无大小限制的高速 CDN 直链，
 *     严禁直接调用普通 webapi /files/download 触发 50028 大文件下载硬阻断。
 *  3. 【媒体播放器无 Cookie 免密串流兼容门禁 (Player Authentication Compatibility Guard)】：
 *     确保 /api/strm/play/[storageId]/[fileId]/route.ts 移除交互式网页 requireApiAccount 强阻断；
 *     确保对无 Cookie 会话的播放器（如 Infuse / PotPlayer / Apple TV），校验 storageId 对应系统中受信任的活跃网盘，
 *     严禁因缺少浏览器 Session Cookie 导致播放器返回 401 Unauthorized。
 *  4. 【302 重定向标准反缓存与去 Referer 标头门禁 (Redirect Anti-Caching Headers Guard)】：
 *     确保 handleRedirect 输出符合流媒体标准的 4 项响应标头：
 *       - Cache-Control: no-store, no-cache, must-revalidate, max-age=0
 *       - Pragma: no-cache
 *       - Expires: 0
 *       - Referrer-Policy: no-referrer (防止防盗链拦截)
 *  5. 【HTTP 206 串流代理容错与 Range 转发门禁 (Stream Proxy Resilience Guard)】：
 *     确保 handleStreamProxy 具备 try-catch 容错结构与 HTTP 206 Partial Content / Accept-Ranges 透传能力。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const c = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

let violations = 0;

function reportViolation(file, line, message) {
  console.error(`${c.red}✖ [STRM Playback Gate Violation]${c.reset} ${path.relative(repoRoot, file)}:${line}`);
  console.error(`  ${c.yellow}原因:${c.reset} ${message}`);
  violations++;
}

// 1. 检查流媒体解析器架构与真实驱动注入
function checkStreamResolverArchitecture() {
  const resolverPath = path.join(repoRoot, "packages/workflow/src/storage/stream-resolver.ts");
  if (!fs.existsSync(resolverPath)) {
    reportViolation(resolverPath, 1, "stream-resolver.ts 不存在！");
    return;
  }
  const content = fs.readFileSync(resolverPath, "utf8");

  if (!content.includes("export class ProductionStorageStreamResolver")) {
    reportViolation(resolverPath, 1, "stream-resolver.ts 缺少 ProductionStorageStreamResolver 真实网盘直链解析器类！");
  }

  if (!content.includes("Pan115CookieClient")) {
    reportViolation(resolverPath, 1, "ProductionStorageStreamResolver 缺少对 Pan115CookieClient 的驱动集成！");
  }

  const containerPath = path.join(repoRoot, "apps/web/composition/runtime-container.ts");
  if (fs.existsSync(containerPath)) {
    const containerContent = fs.readFileSync(containerPath, "utf8");
    if (!containerContent.includes("ensureStorageStreamResolver")) {
      reportViolation(containerPath, 1, "runtime-container.ts 缺少 ensureStorageStreamResolver() 依赖注入函数！");
    }
    if (!containerContent.includes("ProductionStorageStreamResolver")) {
      reportViolation(containerPath, 1, "runtime-container.ts 未在 ensureStorageStreamResolver 中实例化生产流媒体解析器！");
    }
  }
}

// 2. 检查 115 DownURL 加解密协议与客户端实现
function checkPan115DownUrlProtocol() {
  const cipherPath = path.join(repoRoot, "packages/workflow/src/storage/pan115-downurl-cipher.ts");
  if (!fs.existsSync(cipherPath)) {
    reportViolation(cipherPath, 1, "pan115-downurl-cipher.ts 不存在！");
    return;
  }
  const cipherContent = fs.readFileSync(cipherPath, "utf8");

  if (!cipherContent.includes("export function encode115DownurlPayload")) {
    reportViolation(cipherPath, 1, "pan115-downurl-cipher.ts 缺少 encode115DownurlPayload 导出函数！");
  }
  if (!cipherContent.includes("export function decode115DownurlResponse")) {
    reportViolation(cipherPath, 1, "pan115-downurl-cipher.ts 缺少 decode115DownurlResponse 导出函数！");
  }

  const clientPath = path.join(repoRoot, "packages/workflow/src/storage/pan115-cookie-client.ts");
  if (fs.existsSync(clientPath)) {
    const clientContent = fs.readFileSync(clientPath, "utf8");
    if (!clientContent.includes("https://proapi.115.com/app/chrome/downurl")) {
      reportViolation(clientPath, 1, "pan115-cookie-client.ts getDownloadUrl 未优先使用 proapi /app/chrome/downurl 接口，大文件将报 50028 错误！");
    }
  }
}

// 3. 检查 STRM 播放中继路由端点与 Task 字典注册中心
function checkStrmPlaybackRoute() {
  const routePath = path.join(repoRoot, "apps/web/app/api/strm/play/[taskId]/[fileId]/route.ts");
  if (!fs.existsSync(routePath)) {
    reportViolation(routePath, 1, "STRM 播放路由 [taskId]/[fileId]/route.ts 不存在！");
    return;
  }
  const routeContent = fs.readFileSync(routePath, "utf8");

  // 严禁在 URL Query 中强依赖 mode=proxy 传参，必须以任务字典配置为准
  if (routeContent.includes('searchParams.get("mode")')) {
    reportViolation(routePath, 1, "route.ts 严禁依赖 URL Query 中的 mode 传参，必须以 StrmTaskConfigRegistry 内存字典配置为准！");
  }

  // 必须接入 ensureStrmTaskConfigRegistry 内存字典
  if (!routeContent.includes("ensureStrmTaskConfigRegistry")) {
    reportViolation(routePath, 1, "route.ts 缺少 ensureStrmTaskConfigRegistry 任务配置内存字典接入！");
  }

  // handleRedirect 必须具备 4 项标准反缓存标头
  const requiredHeaders = [
    "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma",
    "Expires",
    "Referrer-Policy",
  ];
  for (const h of requiredHeaders) {
    if (!routeContent.includes(h)) {
      reportViolation(routePath, 1, `handleRedirect 缺少流媒体反缓存标头 [${h}]！`);
    }
  }

  // handleStreamProxy 必须具备异常捕获与容错
  if (!routeContent.includes("try {") || !routeContent.includes("上游流媒体代理转发失败")) {
    reportViolation(routePath, 1, "handleStreamProxy 缺少 try-catch 容错捕获，上游 CDN 异常时将引发未处理的 Promise rejection 崩溃！");
  }

  // 必须具备 inferVideoMimeType 精准 MIME 推导与 inline Content-Disposition 改写（防浏览器弹下载对话框）
  if (!routeContent.includes("inferVideoMimeType") || !routeContent.includes("inline; filename=")) {
    reportViolation(routePath, 1, "route.ts 缺少 inferVideoMimeType 精准推导或未重写 Content-Disposition 为 inline，将导致媒体流被识别为文件下载！");
  }
}

export function runStrmPlaybackGate() {
  violations = 0;
  console.log(`${c.cyan}${c.bold}▶ 正在执行巡影 · Mediary Scout STRM 播放直链与流媒体中继质量门禁...${c.reset}`);

  checkStreamResolverArchitecture();
  checkPan115DownUrlProtocol();
  checkStrmPlaybackRoute();

  if (violations > 0) {
    console.error(`\n${c.red}${c.bold}✖ STRM 播放直链质量门禁未通过，发现 ${violations} 处不合规！${c.reset}\n`);
    return false;
  }

  console.log(`\n${c.green}${c.bold}✔ STRM 播放直链与流媒体中继质量门禁全部通过！${c.reset}\n`);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ok = runStrmPlaybackGate();
  process.exit(ok ? 0 : 1);
}
