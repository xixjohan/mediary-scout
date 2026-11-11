#!/usr/bin/env node
/**
 * STRM 数据路径与防 CWD 漂移架构门禁（Guard Gate）：
 * 
 * 核心设计规则：
 * 1. Monorepo 与 Standalone 部署环境下，严禁在 STRM 路径解析及文件系统浏览中使用
 *    `path.join(process.cwd(), "data")` 作为数据根目录，必须单源使用 `resolveDataRoot()`；
 * 2. `packages/workflow/src/strm/output-path.ts` 必须支持标准绝对路径 `/app/data/...` 并使用 `resolveDataRoot()`；
 * 3. 前端 `LocalFolderPickerModal` 严禁出现对 `/app/` 前缀的硬编码裁剪，必须原生传递与展示标准路径；
 * 4. `Dockerfile` 与 `Dockerfile.dev` 必须显式声明 `ENV MEDIA_TRACK_DATA_DIR=/app/data`；
 * 5. `scripts/deploy-remote.ps1` 启动开发与生产容器时必须注入 `-e MEDIA_TRACK_DATA_DIR=/app/data`。
 * 
 * 退出码 0 = 检查通过；1 = 发现违规项（打印违规文件与行号）。
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const violations = [];

// 1. 检查 output-path.ts
const outputPathFile = join(root, "packages", "workflow", "src", "strm", "output-path.ts");
if (existsSync(outputPathFile)) {
  const content = readFileSync(outputPathFile, "utf8");
  const rel = relative(root, outputPathFile).replace(/\\/g, "/");
  if (!content.includes("export function resolveDataRoot")) {
    violations.push({
      file: rel,
      rule: "MISSING_RESOLVE_DATA_ROOT",
      message: "output-path.ts 必须导出权威单源 resolveDataRoot 函数",
    });
  }
  if (content.includes('path.resolve(process.cwd(), "data")') && !content.includes("let current = path.resolve(process.cwd())")) {
    violations.push({
      file: rel,
      rule: "RAW_CWD_DATA_JOIN",
      message: "检测到直接以 process.cwd() 拼接 data 目录，存在 Next.js Standalone apps/web 漂移漏洞",
    });
  }
}

// 2. 检查 fs-browse/route.ts
const fsBrowseFile = join(root, "apps", "web", "app", "api", "system", "fs-browse", "route.ts");
if (existsSync(fsBrowseFile)) {
  const content = readFileSync(fsBrowseFile, "utf8");
  const rel = relative(root, fsBrowseFile).replace(/\\/g, "/");
  if (!content.includes("resolveDataRoot")) {
    violations.push({
      file: rel,
      rule: "FS_BROWSE_MISSING_RESOLVE_DATA_ROOT",
      message: "fs-browse/route.ts 必须使用 resolveDataRoot 解析数据目录",
    });
  }
  if (content.includes('path.join(process.cwd(), "data")')) {
    violations.push({
      file: rel,
      rule: "FS_BROWSE_RAW_CWD_DATA",
      message: "fs-browse/route.ts 中禁止使用 path.join(process.cwd(), \"data\")",
    });
  }
}

// 3. 检查 local-folder-picker-modal.tsx
const modalFile = join(root, "apps", "web", "features", "strm", "components", "local-folder-picker-modal.tsx");
if (existsSync(modalFile)) {
  const content = readFileSync(modalFile, "utf8");
  const rel = relative(root, modalFile).replace(/\\/g, "/");
  if (content.includes(".replace(/^\\/app\\//, \"\")")) {
    violations.push({
      file: rel,
      rule: "FRAGILE_PATH_STRIPPING",
      message: "local-folder-picker-modal 严禁硬编码裁剪 /app/ 前缀",
    });
  }
}

// 4. 检查 Dockerfile 与 Dockerfile.dev
for (const dockerfile of ["Dockerfile", "Dockerfile.dev"]) {
  const dfPath = join(root, dockerfile);
  if (existsSync(dfPath)) {
    const content = readFileSync(dfPath, "utf8");
    if (!content.includes("MEDIA_TRACK_DATA_DIR=/app/data")) {
      violations.push({
        file: dockerfile,
        rule: "MISSING_DATA_DIR_ENV",
        message: `${dockerfile} 必须声明 ENV MEDIA_TRACK_DATA_DIR=/app/data`,
      });
    }
  }
}

// 5. 检查 deploy-remote.ps1
const deployScript = join(root, "scripts", "deploy-remote.ps1");
if (existsSync(deployScript)) {
  const content = readFileSync(deployScript, "utf8");
  if (!content.includes("-e MEDIA_TRACK_DATA_DIR=/app/data")) {
    violations.push({
      file: "scripts/deploy-remote.ps1",
      rule: "DEPLOY_SCRIPT_MISSING_DATA_DIR",
      message: "scripts/deploy-remote.ps1 启动容器时必须注入 -e MEDIA_TRACK_DATA_DIR=/app/data",
    });
  }
}

if (violations.length > 0) {
  console.error(`\n❌ STRM 数据路径与防漂移架构门禁失败，共发现 ${violations.length} 处违规：`);
  for (const v of violations) {
    console.error(`  - [${v.rule}] ${v.file}: ${v.message}`);
  }
  process.exit(1);
} else {
  console.log("✅ STRM 数据路径与防漂移架构门禁检查通过：resolveDataRoot 单源权威，容器环境变量对齐，杜绝 CWD 漂移。");
  process.exit(0);
}
