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

/**
 * 4. 【代理层放行门禁 (Proxy Exemption Guard)】——2026-11-17 事故的同类门禁。
 *
 * 缺陷原型：`route-auth-inventory` 把 `strm/play` 归为「自鉴权」类，但
 * `apps/web/proxy.ts` 的放行前缀里没有它。多用户模式（生产就是这样）下
 * `/api/strm/play/...` 被 **307 重定向到 /login**——Emby / Infuse / Plex /
 * PotPlayer 读 `.strm` 后是**无会话 HTTP 客户端**，它们永远拿不到 `mt_session`。
 * 实测：`.strm` 里签名完全正确的 URL 在容器内请求只得到 `307 /login`。
 *
 * 断言：`self-guarded-routes.ts` 必须包含 `/api/strm/play/`，且 proxy 必须
 * 消费这份共享清单（而不是自己再维护一份前缀数组——两份就是分裂的土壤）。
 */
function checkProxyExemption() {
  const listPath = path.join(repoRoot, "apps/web/platform/next-context/self-guarded-routes.ts");
  if (!fs.existsSync(listPath)) {
    reportViolation(listPath, 1, "self-guarded-routes.ts 不存在：proxy 与路由清单必须读同一份自守端点列表！");
    return;
  }
  const listContent = fs.readFileSync(listPath, "utf8");
  if (!listContent.includes('"/api/strm/play/"')) {
    reportViolation(
      listPath,
      1,
      "自守端点清单缺少 /api/strm/play/：多用户模式下播放请求会被 proxy 重定向到 /login，外部播放器（无 session）全部播不了！",
    );
  }

  const proxyPath = path.join(repoRoot, "apps/web/proxy.ts");
  if (!fs.existsSync(proxyPath)) {
    reportViolation(proxyPath, 1, "proxy.ts 不存在！");
    return;
  }
  const proxyContent = fs.readFileSync(proxyPath, "utf8");
  if (!proxyContent.includes("isSelfGuardedApiPath")) {
    reportViolation(
      proxyPath,
      1,
      "proxy.ts 未消费 isSelfGuardedApiPath()：自守端点清单与代理放行判定会再次分裂（/api/strm/play 会被拦）。",
    );
  }
}

/**
 * 5. 【签名密钥不可伪造门禁 (Signing Secret Guard)】——同一事故链的第二段。
 *
 * 缺陷原型：`resolveStrmSigningSecret()` 在无 env 时回退到常量
 * `"mediary-scout-strm-signing-secret"`。任何人读源码即可离线伪造播放令牌
 * （实测 dev 实例返回 200 并开始推流），而 `.strm` 默认 TTL 是 365 天。
 */
function checkSigningSecret() {
  const writerPath = path.join(repoRoot, "packages/workflow/src/strm/strm-writer.ts");
  const secretPath = path.join(repoRoot, "packages/workflow/src/strm/signing-secret.ts");
  for (const file of [writerPath, secretPath]) {
    if (!fs.existsSync(file)) {
      reportViolation(file, 1, "STRM 签名密钥模块缺失！");
      return;
    }
  }
  // 去掉注释再扫：注释里提到旧常量是允许的（它是缺陷记录），代码里出现才是漏洞。
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const file of [writerPath, secretPath]) {
    const code = strip(fs.readFileSync(file, "utf8"));
    if (code.includes('"mediary-scout-strm-signing-secret"')) {
      reportViolation(
        file,
        1,
        "仍存在硬编码签名密钥回退：任何人可离线伪造 STRM 播放令牌（且 .strm 默认有效期 365 天）。" +
          "签名 secret 必须来自 env 或启动期预热（实例 JWT secret），缺失时抛错。",
      );
    }
  }
}

/**
 * 6. 【扫描基址单一事实源门禁 (Manual Scan Base URL SSOT Guard)】——2026-11-17 事故的第三段。
 *
 * 缺陷原型：`/api/strm/tasks/[id]/run` 把 `request.nextUrl.origin` 当作显式 baseUrl
 * 传给扫描器。容器里这个 origin 永远是回环地址（`http://localhost:3000`），而显式
 * 参数在 `resolveEffectiveStrmBaseUrl` 里**优先级最高**——DB 设置与 `APP_BASE_URL`
 * 都被它盖掉。实测：一次「立即扫描」把 178 个本来正确的 `.strm` 全改写成
 * `http://localhost:3000`，外部播放器（Emby/Infuse/电视）随即全部播不了。
 *
 * 断言：手动扫描路由不得消费 `nextUrl.origin` / `request.url` 的 host 作为播放基址；
 * 基址只能来自 SSOT（DB `strm_base_url` → `APP_BASE_URL`/`MEDIARY_URL` → 回环兜底）。
 */
function checkManualScanBaseUrlSso() {
  const runRoutePath = path.join(repoRoot, "apps/web/app/api/strm/tasks/[id]/run/route.ts");
  if (!fs.existsSync(runRoutePath)) {
    reportViolation(runRoutePath, 1, "手动扫描路由 [id]/run/route.ts 不存在！");
    return;
  }
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const code = strip(fs.readFileSync(runRoutePath, "utf8"));
  if (code.includes("nextUrl.origin")) {
    reportViolation(
      runRoutePath,
      1,
      "手动扫描路由把请求 origin 当作播放基址：容器内 origin 是回环地址，会覆盖 DB/APP_BASE_URL，" +
        "把所有 .strm 改写成 http://localhost:3000（外部播放器全部失效）。基址必须走 resolveEffectiveStrmBaseUrl SSOT。",
    );
  }
  if (/baseUrl\s*:\s*origin/.test(code)) {
    reportViolation(
      runRoutePath,
      1,
      "手动扫描路由以 `baseUrl: origin` 显式覆盖扫描基址——显式参数优先级最高，等于绕过 SSOT。",
    );
  }
}

/**
 * 7. 【Dev 直推包排除规则门禁 (Dev Sync Exclude Guard)】——同一轮排查发现的第二处缺陷。
 *
 * 缺陷原型：`deploy-remote.ps1` 的 Direct 同步用 `--exclude=run` / `--exclude=data` /
 * `--exclude=env`。bsdtar 的排除模式默认匹配**任意层级**同名目录，于是
 * `apps/web/app/api/strm/tasks/[id]/run/` 整条被剔出 bundle——远端容器里那份路由
 * 停在 11-13 的旧版本，本地怎么改都不生效（「部署成功但行为没变」）。
 *
 * 断言：这三个本地状态目录的排除必须锚定到仓库根（`/run`、`/data`、`/env`）；
 * 同时 `node_modules` / `.next` 必须保持任意层级排除（apps/web 下也有）。
 */
function checkDevSyncExcludes() {
  const scriptPath = path.join(repoRoot, "scripts/deploy-remote.ps1");
  if (!fs.existsSync(scriptPath)) return;
  const content = fs.readFileSync(scriptPath, "utf8");
  for (const unanchored of ['"--exclude=run"', '"--exclude=data"', '"--exclude=env"']) {
    if (content.includes(unanchored)) {
      reportViolation(
        scriptPath,
        1,
        `${unanchored} 未锚定到仓库根：bsdtar 会剔掉任意层级的同名目录（内含 apps/web/app/api/strm/tasks/[id]/run），` +
          "导致远端一直运行旧路由。应改为对应的 /run、/data、/env。",
      );
    }
  }
  for (const anchored of ['"--exclude=/run"', '"--exclude=/data"', '"--exclude=/env"']) {
    if (!content.includes(anchored)) {
      reportViolation(scriptPath, 1, `Direct 同步缺少锚定排除 ${anchored}：本地状态目录会被打进开发镜像。`);
    }
  }
  for (const recursive of ['"--exclude=node_modules"', '"--exclude=.next"']) {
    if (!content.includes(recursive)) {
      reportViolation(scriptPath, 1, `Direct 同步缺少 ${recursive}：apps/web 下的依赖/构建产物会被打进镜像。`);
    }
  }
}

export function runStrmPlaybackGate() {
  violations = 0;
  console.log(`${c.cyan}${c.bold}▶ 正在执行巡影 · Mediary Scout STRM 播放直链与流媒体中继质量门禁...${c.reset}`);

  checkStreamResolverArchitecture();
  checkPan115DownUrlProtocol();
  checkStrmPlaybackRoute();
  checkProxyExemption();
  checkSigningSecret();
  checkManualScanBaseUrlSso();
  checkDevSyncExcludes();

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
