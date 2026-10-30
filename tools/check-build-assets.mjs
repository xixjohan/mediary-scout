#!/usr/bin/env node
/**
 * scripts/check-build-assets.mjs
 * 
 * 静态分块物理一致性门禁 (Asset Integrity Gate)
 * 验证 apps/web/.next 构建产物中的所有 HTML 和 Manifest 所引用的静态 JS/CSS 分块
 * 在磁盘上的物理路径全部真实存在且非空，防止出现任何悬空 Chunk 引用导致 500 / ChunkLoadError。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextDir = path.join(repoRoot, "apps/web/.next");
const staticDir = path.join(nextDir, "static");

function collectFiles(dir, predicate, accumulator = []) {
  if (!fs.existsSync(dir)) return accumulator;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "dev" || entry.name === "cache") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, predicate, accumulator);
    } else if (predicate(entry.name)) {
      accumulator.push(fullPath);
    }
  }
  return accumulator;
}

function normalizeAssetPath(assetRef) {
  // e.g. "/_next/static/chunks/xyz.js" -> "static/chunks/xyz.js"
  // or "static/chunks/xyz.js" -> "static/chunks/xyz.js"
  let clean = assetRef.trim().split("?")[0].split("#")[0];
  if (clean.startsWith("/_next/")) {
    clean = clean.slice("/_next/".length);
  }
  if (clean.startsWith("/")) {
    clean = clean.slice(1);
  }
  return clean;
}

function main() {
  if (!fs.existsSync(nextDir)) {
    console.log("ℹ [Asset Gate] 未检测到 apps/web/.next 目录，跳过构建分块物理校验。");
    process.exit(0);
  }

  const referencedAssets = new Set();

  // 1. 从所有 build-manifest.json 收集引用的分块
  const manifestFiles = collectFiles(nextDir, (name) => name.endsWith("build-manifest.json"));
  for (const manifestPath of manifestFiles) {
    try {
      const content = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const arraysToInspect = [
        content.polyfillFiles,
        content.lowPriorityFiles,
        content.rootMainFiles,
        ...(content.pages ? Object.values(content.pages) : []),
      ];
      for (const arr of arraysToInspect) {
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (typeof item === "string" && (item.endsWith(".js") || item.endsWith(".css"))) {
              referencedAssets.add(normalizeAssetPath(item));
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[Asset Gate] 解析 Manifest 失败: ${manifestPath}`, e.message);
    }
  }

  // 2. 从预渲染生成的 HTML 页面中用正则抓取 /_next/static/...
  const htmlFiles = collectFiles(path.join(nextDir, "server/app"), (name) => name.endsWith(".html"));
  const regex = /\/_next\/static\/[a-zA-Z0-9_\-\.\/]+\.(?:js|css)/g;
  for (const htmlPath of htmlFiles) {
    try {
      const html = fs.readFileSync(htmlPath, "utf8");
      let match;
      while ((match = regex.exec(html)) !== null) {
        referencedAssets.add(normalizeAssetPath(match[0]));
      }
    } catch (e) {
      console.warn(`[Asset Gate] 读取 HTML 失败: ${htmlPath}`, e.message);
    }
  }

  if (referencedAssets.size === 0) {
    console.log("ℹ [Asset Gate] 未检测到静态资产引用，跳过。");
    process.exit(0);
  }

  // 3. 逐个验证文件物理存在且非空
  const missingAssets = [];
  for (const relPath of referencedAssets) {
    const physicalPath = path.join(nextDir, relPath);
    if (!fs.existsSync(physicalPath)) {
      missingAssets.push({ path: relPath, reason: "文件不存在" });
      continue;
    }
    const stat = fs.statSync(physicalPath);
    if (stat.size === 0) {
      missingAssets.push({ path: relPath, reason: "空文件 (0 字节)" });
    }
  }

  if (missingAssets.length > 0) {
    console.error(`✖ [Asset Gate] 发现 ${missingAssets.length} 处失效静态分块引用：`);
    for (const item of missingAssets) {
      console.error(`  - ${item.path} (${item.reason})`);
    }
    process.exit(1);
  }

  console.log(`✔ [Asset Gate] 静态资产物理一致性检验通过（已验证 ${referencedAssets.size} 个分块，0 处悬空引用）`);
}

main();
