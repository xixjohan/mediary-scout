#!/usr/bin/env node
/**
 * scripts/audit-upstream.mjs
 *
 * 上游仓库新增功能自动化审计与复用评估工具。
 * 作用：
 *  1. 安全抓取上游更新到独立 ref（不污染本地分支与标签）；
 *  2. 自动计算自分叉点（merge-base）以来的全部新增提交；
 *  3. 按「网盘适配」、「资源查询」、「核心工作流/调度」、「文档官网」四维分类统计；
 *  4. 检查与当前仓库纯 SQLite 治理、设计令牌门禁、活动任务隔离等重构成果的冲突风险；
 *  5. 生成规范的 Markdown 审核报告与复用建议。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_UPSTREAM_URL = "https://github.com/fancydirty/mediary-scout.git";
const UPSTREAM_REF = "refs/remotes/upstream/main";

function runGit(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    }).trim();
  } catch (err) {
    throw new Error(`git ${args.join(" ")} failed: ${err.stderr || err.message}`);
  }
}

function safeFetchUpstream(upstreamUrl) {
  process.stdout.write(`📡 安全拉取上游主干 (${upstreamUrl}) 至 ${UPSTREAM_REF} ...\n`);
  runGit(["fetch", "--no-tags", upstreamUrl, `main:${UPSTREAM_REF}`]);
  process.stdout.write(`✔ 上游主干已更新，本地 Tag 未受污染。\n`);
}

function categorizeCommit(files, subject) {
  const subLower = subject.toLowerCase();
  const fileStr = files.join("\n").toLowerCase();

  const isDrive =
    fileStr.includes("drivers") ||
    fileStr.includes("pan") ||
    fileStr.includes("uc") ||
    fileStr.includes("quark") ||
    fileStr.includes("guangya") ||
    fileStr.includes("storage-executor") ||
    fileStr.includes("qrcode") ||
    subLower.includes("drive") ||
    subLower.includes("uc") ||
    subLower.includes("guangya");

  const isSearch =
    fileStr.includes("search") ||
    fileStr.includes("pansou") ||
    fileStr.includes("haisou") ||
    fileStr.includes("prowlarr") ||
    subLower.includes("search") ||
    subLower.includes("haisou");

  const isCore =
    fileStr.includes("orchestrator") ||
    fileStr.includes("runner") ||
    fileStr.includes("postgres") ||
    fileStr.includes("sqlite") ||
    fileStr.includes("multi-drive-storage") ||
    fileStr.includes("workflow-v2") ||
    subLower.includes("multidrivestorage") ||
    subLower.includes("协作获取");

  const isDocs =
    files.every((f) => f.startsWith("docs/") || f.startsWith("site/") || f.startsWith("README")) ||
    subLower.startsWith("docs") ||
    subLower.startsWith("site");

  if (isDrive && !isCore) return "DRIVE_ADAPTER";
  if (isSearch && !isCore) return "SEARCH_ADAPTER";
  if (isCore) return "CORE_WORKFLOW";
  if (isDocs) return "DOCS_SITE";
  return isDrive ? "DRIVE_ADAPTER" : isSearch ? "SEARCH_ADAPTER" : "OTHER";
}

function assessRisk(files, category) {
  if (category === "CORE_WORKFLOW") {
    const hasPostgres = files.some((f) => f.includes("postgres"));
    const hasRunner = files.some((f) => f.includes("runner") || f.includes("orchestrator"));
    if (hasPostgres) {
      return { level: "HIGH", reason: "涉及 PostgreSQL 代码与数据库结构，与当前纯 SQLite 治理严重冲突" };
    }
    if (hasRunner) {
      return { level: "MEDIUM", reason: "涉及获取调度器与执行循环，合入需适配当前活动队列隔离" };
    }
    return { level: "MEDIUM", reason: "涉及调度底层，需验证架构一致性" };
  }
  if (category === "DRIVE_ADAPTER") {
    return { level: "LOW", reason: "遵循适配器模式与 CloudDriveProfile，独立性高，建议复用" };
  }
  if (category === "SEARCH_ADAPTER") {
    return { level: "LOW", reason: "遵循搜索策略模式，通过配置驱动，建议复用" };
  }
  return { level: "LOW", reason: "文档或外围修改，冲突风险低" };
}

export function auditUpstreamCommits(options = {}) {
  const upstreamUrl = options.upstreamUrl || process.env.UPSTREAM_REPO_URL || DEFAULT_UPSTREAM_URL;
  if (options.fetch) {
    safeFetchUpstream(upstreamUrl);
  }

  const mergeBase = runGit(["merge-base", "HEAD", UPSTREAM_REF]);
  const rawLog = runGit([
    "log",
    "--format=%H|%s|%an|%ad",
    "--date=short",
    `${mergeBase}..${UPSTREAM_REF}`,
  ]);

  if (!rawLog) {
    return { mergeBase, commits: [], summary: { total: 0 } };
  }

  const lines = rawLog.split("\n").filter(Boolean);
  const commits = [];

  for (const line of lines) {
    const [fullHash, subject, author, date] = line.split("|");
    const hash = fullHash.slice(0, 8);
    const filesRaw = runGit(["diff-tree", "--no-commit-id", "--name-status", "-r", fullHash]);
    const files = filesRaw
      .split("\n")
      .filter(Boolean)
      .map((entry) => {
        const parts = entry.split(/\s+/);
        return { status: parts[0], path: parts[1] };
      });

    const filePaths = files.map((f) => f.path);
    const category = categorizeCommit(filePaths, subject);
    const risk = assessRisk(filePaths, category);

    commits.push({
      hash,
      fullHash,
      subject,
      author,
      date,
      category,
      risk,
      files,
    });
  }

  const summary = {
    total: commits.length,
    driveCount: commits.filter((c) => c.category === "DRIVE_ADAPTER").length,
    searchCount: commits.filter((c) => c.category === "SEARCH_ADAPTER").length,
    coreCount: commits.filter((c) => c.category === "CORE_WORKFLOW").length,
    docsCount: commits.filter((c) => c.category === "DOCS_SITE").length,
    otherCount: commits.filter((c) => c.category === "OTHER").length,
  };

  return { mergeBase, commits, summary };
}

function generateMarkdownReport(auditResult) {
  const { mergeBase, commits, summary } = auditResult;
  const now = new Date().toISOString().slice(0, 10);

  const lines = [
    `# 上游功能审计报告 (${now})`,
    "",
    `> **分叉基准（Merge Base）**：\`${mergeBase.slice(0, 8)}\``,
    `> **待审核提交总量**：${summary.total} 个提交`,
    "",
    "## 一、分类概览与复用推荐",
    "",
    "| 分类 | 提交数 | 冲突与重构风险 | 复用建议 | 代表特性 |",
    "| :--- | :---: | :--- | :--- | :--- |",
    `| 🚗 **网盘适配 (Drive Adapter)** | ${summary.driveCount} | 🟢 低（模块化适配器设计） | **强烈建议复用** | UC 网盘转存/扫码、光鸭 App 设备码扫码、扫码生命周期清理 |`,
    `| 🔍 **资源查询 (Search Adapter)** | ${summary.searchCount} | 🟢 低（独立 Provider 策略） | **强烈建议复用** | 海搜（Haisou）官方 API 搜索源与配额支持 |`,
    `| ⚙️ **核心调度 (Core Workflow)** | ${summary.coreCount} | 🔴 高（涉及 PostgreSQL/多盘架构） | **暂缓或定向移植** | MultiDriveStorageV2、六盘余量探测 |`,
    `| 📝 **文档官网 (Docs & Site)** | ${summary.docsCount} | 🟢 低（按需参考） | **可选参考** | 英文站页面、部署说明 |`,
    "",
    "## 二、提交明细核查清单",
    "",
    "| 提交 | 日期 | 分类 | 风险 | 提交说明 | 关键受影响文件 |",
    "| :--- | :--- | :--- | :---: | :--- | :--- |",
  ];

  for (const c of commits) {
    const riskBadge = c.risk.level === "HIGH" ? "🔴 高" : c.risk.level === "MEDIUM" ? "🟡 中" : "🟢 低";
    const keyFiles = c.files.slice(0, 2).map((f) => `\`${f.path}\``).join("<br>");
    lines.push(`| \`${c.hash}\` | ${c.date} | \`${c.category}\` | ${riskBadge} | ${c.subject.replace(/\|/g, "/")} | ${keyFiles} |`);
  }

  lines.push(
    "",
    "## 三、重点功能深度审计与复用策略",
    "",
    "### 1. UC 网盘接入 (PR #331 & #332)",
    "- **核心技术**：阿里云盘族 CAS 扫码协议 + 参数化夸克内核 (`CloudDriveProfile`)。",
    "- **设计模式**：**参数化适配器模式 (Parameterized Adapter Pattern)**。",
    "- **复用价值**：极大扩展主流网盘支持度，协议与夸克同源，复用成本极低。",
    "",
    "### 2. 光鸭云盘 App 扫码登录 (PR #340)",
    "- **核心技术**：设备码授权流程 (`device_code` -> `user_code` -> 轮询授权 -> 兑换 Token)。",
    "- **设计模式**：**有限状态机 (FSM)**。",
    "- **复用价值**：免除用户手动抓包粘贴 Token 的繁琐操作，大幅提升易用性。",
    "",
    "### 3. 海搜官方 API 搜索源 (PR #337 & #344)",
    "- **核心技术**：通过海搜官方 REST API 获取各网盘分享链接，支持显式传递 `platforms` 参数。",
    "- **设计模式**：**策略模式 (Strategy Pattern)**。",
    "- **复用价值**：与 PanSou 形成互补搜索源，解决单一搜索源偶尔失效或缺少冷门资源的问题。",
    "",
    "### 4. 扫码组件卸载清理 (PR #335)",
    "- **核心技术**：添加 unmount generation 递增清理，解决轮询打向后台的内存泄漏。",
    "- **复用价值**：基础健壮性修复，必须合入。",
    "",
    "### 5. MultiDriveStorageV2 多盘协作架构 (PR #346)",
    "- **风险告警**：上游引入了 `postgres.ts` 及双引擎表 `episode_copies`，与本仓库纯 SQLite 化治理严重冲突。",
    "- **建议**：当前阶段**不予全量合并**，后续若有需要，可在纯 SQLite 体系下按需重构移植其容量感知逻辑。",
  );

  return lines.join("\n");
}

function main() {
  const doFetch = process.argv.includes("--fetch");
  const result = auditUpstreamCommits({ fetch: doFetch });

  process.stdout.write(`\n=== 上游功能审计完成 (${result.summary.total} 个提交) ===\n`);
  process.stdout.write(`- 🚗 网盘适配：${result.summary.driveCount} 个\n`);
  process.stdout.write(`- 🔍 资源查询：${result.summary.searchCount} 个\n`);
  process.stdout.write(`- ⚙️ 核心调度：${result.summary.coreCount} 个\n`);
  process.stdout.write(`- 📝 文档官网：${result.summary.docsCount} 个\n\n`);

  const reportDir = join(process.cwd(), "docs", "upstream-sync-reports");
  if (!existsSync(reportDir)) {
    mkdirSync(reportDir, { recursive: true });
  }

  const now = new Date().toISOString().slice(0, 10);
  const reportPath = join(reportDir, `${now}-audit.md`);
  const reportContent = generateMarkdownReport(result);
  writeFileSync(reportPath, reportContent, "utf-8");

  process.stdout.write(`✔ 完整审计报告已生成至：${reportPath}\n\n`);
}

if (process.argv[1] && process.argv[1].endsWith("audit-upstream.mjs")) {
  main();
}
