#!/usr/bin/env node
/**
 * 前后端功能对齐与防孤儿路由架构门禁 (Feature Parity & Anti-Orphan-API Gate)
 *
 * 核心检查规则：
 *   1. 检查 apps/web/app/api/* 下的所有 API 路由是否在前端视图层 (apps/web/features/ 或 apps/web/app/) 中存在有效消费者，
 *      杜绝“后端写好端点、前端完全遗忘”的孤儿接口问题；
 *   2. 检查 apps/web/app/settings/* 下的设置子页面是否在主设置页或导航中拥有可见入口；
 *   3. 检查反服务错位深埋约束：核心服务（如媒体服务器）严禁被作为私有子节点错误嵌套在不相干模块（如字幕源）中。
 *
 * 退出码：0 = 全部通过；1 = 发现孤儿接口或违规深埋。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const apiDir = join(root, "apps/web/app/api");
const settingsDir = join(root, "apps/web/app/settings");
const featuresDir = join(root, "apps/web/features");
const appDir = join(root, "apps/web/app");
const allowlistPath = join(root, "tools/gates/api-parity-allowlist.json");

const problems = [];
let checkedRoutesCount = 0;
let checkedSettingsCount = 0;

// 1. 读取豁免白名单
let allowlist = [];
if (existsSync(allowlistPath)) {
  try {
    const data = JSON.parse(readFileSync(allowlistPath, "utf8"));
    allowlist = data.allowedOrphans || [];
  } catch (e) {
    problems.push(`读取白名单配置失败: ${String(e)}`);
  }
}

function isAllowlisted(apiPath) {
  return allowlist.some((item) => apiPath === item.prefix || apiPath.startsWith(item.prefix + "/"));
}

// 2. 递归收集所有 API 路由
function collectApiRoutes(dir, list = []) {
  if (!existsSync(dir)) return list;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectApiRoutes(full, list);
    } else if (entry.isFile() && entry.name === "route.ts") {
      const rel = relative(apiDir, full).replace(/\\/g, "/");
      const routePath = "/api/" + rel.replace(/\/route\.ts$/, "");
      list.push({ fullPath: full, routePath });
    }
  }
  return list;
}

// 3. 递归收集前端消费源码（纯文本集合）
function collectConsumerSource(dir, acc = "") {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // 跳过 app/api 自身与测试目录
      if (entry.name === "api" || entry.name === "__tests__" || entry.name === "tests") continue;
      acc += collectConsumerSource(full);
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      if (!entry.name.includes(".test.")) {
        acc += "\n" + readFileSync(full, "utf8");
      }
    }
  }
  return acc;
}

const allApiRoutes = collectApiRoutes(apiDir);
const webDir = join(root, "apps/web");
const consumerSource = [
  featuresDir,
  appDir,
  join(webDir, "components"),
  join(webDir, "lib"),
  join(webDir, "composition"),
].map((dir) => collectConsumerSource(dir)).join("\n");

// 4. 执行 API 消费完整性校验
for (const { routePath } of allApiRoutes) {
  checkedRoutesCount++;
  if (isAllowlisted(routePath)) continue;

  // 将 [id] 或动态参数通配
  const baseSegment = routePath.split("/[")[0];
  const searchCandidates = [
    routePath,
    baseSegment,
    routePath.replace(/\/\w+$/, ""), // 上级路由
  ].filter(Boolean);

  const isConsumed = searchCandidates.some((candidate) => {
    // 检查是否存在字符串引用（如 fetch('/api/tunnel/lines') 或 `/api/mediaserver/configs`）
    return consumerSource.includes(`"${candidate}`) ||
      consumerSource.includes(`'${candidate}`) ||
      consumerSource.includes(`\`${candidate}`);
  });

  if (!isConsumed) {
    problems.push(`[孤儿 API 路由] ${routePath}: 前端视图层未发现任何消费调用，且未在 api-parity-allowlist.json 中登记豁免。`);
  }
}

// 5. 校验设置页子路由注册完整性
if (existsSync(settingsDir)) {
  const settingsPageContent = existsSync(join(settingsDir, "page.tsx"))
    ? readFileSync(join(settingsDir, "page.tsx"), "utf8")
    : "";

  for (const entry of readdirSync(settingsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      checkedSettingsCount++;
      const subDir = join(settingsDir, entry.name);
      if (existsSync(join(subDir, "page.tsx"))) {
        const subRoute = `/settings/${entry.name}`;
        // 必须在主设置页或 features/settings-system 中有链接或引用
        const hasLink = settingsPageContent.includes(subRoute) || consumerSource.includes(subRoute);
        if (!hasLink) {
          problems.push(`[孤岛设置页] ${subRoute}: 拥有独立的 page.tsx 但在主设置页中缺失可见导航链接。`);
        }
      }
    }
  }

  // 6. 反错位反深埋硬约束校验
  if (settingsPageContent.includes("async function SubtitleSourceSection")) {
    const subtitleMatch = settingsPageContent.match(/async function SubtitleSourceSection[\s\S]*?^}/m);
    if (subtitleMatch && (subtitleMatch[0].includes("MediaServer") || subtitleMatch[0].includes("媒体服务器"))) {
      problems.push(`[反错位门禁违规] SubtitleSourceSection (字幕源) 内部错误嵌套了媒体服务器 ServiceBlock，严禁将核心服务深埋在不相干小分类中。`);
    }
  }
}

// 7. 输出检查看板
console.log(`\n========================================================`);
console.log(`     巡影 架构质量门禁 · 前后端功能对齐与孤儿路由看板     `);
console.log(`========================================================`);
console.log(`已审计 API 路由总数: ${checkedRoutesCount}`);
console.log(`已审计设置子页面数: ${checkedSettingsCount}`);
console.log(`白名单豁免端点数: ${allowlist.length}`);
console.log(`--------------------------------------------------------`);

if (problems.length > 0) {
  console.error(`\n❌ [GATE FAILURE] 发现 ${problems.length} 处前后端脱节违规 (硬阻断):\n`);
  for (const p of problems) {
    console.error(`  - ${p}`);
  }
  console.error(`\n💡 修复建议:`);
  console.error(`  1. 若该端点已实现，请在前端对应 feature 组件中补齐调用视图与 UI 交互；`);
  console.error(`  2. 若该端点属于纯外部 Webhook/探针/移动端通道，请在 tools/gates/api-parity-allowlist.json 中显式登记豁免原因；`);
  console.error(`  3. 严禁创建孤立子页面而不挂载主导航入口。\n`);
  process.exit(1);
} else {
  console.log(`\n✔ [Parity Gate] 前后端功能对齐与孤儿路由门禁通过！(0 孤儿路由, 0 孤岛设置页, 0 错位深埋)\n`);
  process.exit(0);
}
