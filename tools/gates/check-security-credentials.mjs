#!/usr/bin/env node
/**
 * 巡影 · Mediary Scout 凭据安全红线与脱敏规范检测门禁 (Security & Credential Gate)
 *
 * 核心设计目标：
 *  1. 【高危凭据/Token阻断】：全面拦截未脱敏的 OpenAI Key (sk-*)、LinuxWebTool Token (lwt_live_*)、GitHub PAT、未 Mock 私钥等。
 *  2. 【网络地址与敏感拓扑阻断】：拦截开发机私网特定 IP (10.126.*.*)、非标 SSH 端口、真实用户 Slug 与 CF Zone ID。
 *  3. 【硬编码密码与组网密钥阻断】：拦截 WEB_ADMIN_PASSWORD 真实密码、EasyTier network_secret 真实密钥。
 *  4. 【双输入适配器与极速增量支持】：支持 --staged 毫秒级增量扫描（用于 Git Hook），以及全量仓库扫描（用于 npm run gate）。
 *  5. 【白名单与基线机制】：内置 AGENTS.md §7 标准规范占位符放行机制，支持 tools/gates/security-suppressions.json 基线。
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const suppressionsPath = path.join(repoRoot, "tools/gates/security-suppressions.json");

const c = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

/** 计算字符串的香农信息熵 */
export function calculateShannonEntropy(str) {
  if (!str || str.length === 0) return 0;
  const frequencies = new Map();
  for (const char of str) {
    frequencies.set(char, (frequencies.get(char) || 0) + 1);
  }
  let entropy = 0;
  const len = str.length;
  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** 规范占位符特征 (遇到直接放行) */
export const COMPLIANT_PLACEHOLDERS = [
  /sk-proj-test-secret-key-1234567890/,
  /sk-test-super-secret-12345/,
  /sk-test-key-abcdef-1234/,
  /sk-env-secret-value-0001/,
  /lwt_live_8f3a9e\.\.\./,
  /msk_live_9a8b7c6d5e4f3a2b1c0d9e8f/,
  /cf_zone_0123456789abcdef0123456789abcdef/,
  /tunnel_0123456789abcdef0123456789abcdef/,
  /your_secure_password_here/,
  /<ADMIN_PASSWORD>/,
  /MOCK_KEY_DATA/,
  /demo_secret_token/,
  /example\.com/,
  /127\.0\.0\.1/,
  /0\.0\.0\.0/,
  /172\.17\.0\.1/,
  /host\.docker\.internal/,
];

/** 检测规则策略集 (Detector Strategies) */
export const DETECTOR_RULES = [
  {
    id: "SEC-001-OPENAI-KEY",
    name: "真实大模型 API Key",
    regex: /\bsk-[a-zA-Z0-9_-]{20,}\b/g,
    suggestion: "必须使用规范占位符（如 sk-proj-test-secret-key-1234567890 或包含 *** / test）",
    check: (match, line) => {
      if (line.includes("***") || line.includes("...") || /test|mock|sample|example/i.test(match)) {
        return false;
      }
      return calculateShannonEntropy(match) >= 3.0;
    },
  },
  {
    id: "SEC-002-LWT-KEY",
    name: "真实 LinuxWebTool 访问令牌",
    regex: /\blwt_live_[a-f0-9]{20,}\b/g,
    suggestion: "必须使用规范占位符 lwt_live_8f3a9e... 或包含 ***",
    check: (match) => {
      return !match.includes("...") && !match.includes("***") && !/test|mock|sample/i.test(match);
    },
  },
  {
    id: "SEC-003-MSK-KEY",
    name: "未脱敏 Mediary Scout Key",
    regex: /\bmsk_live_[a-zA-Z0-9_-]{20,}\b/g,
    suggestion: "文档与测试必须使用 msk_live_... 或标准测试 Token",
    check: (match) => {
      if (match.includes("...") || match.includes("***") || /test|valid|dummy|mock/i.test(match)) {
        return false;
      }
      return calculateShannonEntropy(match) >= 3.2;
    },
  },
  {
    id: "SEC-004-GITHUB-PAT",
    name: "GitHub Personal Access Token",
    regex: /\b(?:ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{82})\b/g,
    suggestion: "严禁在代码或文档中明文写入 GitHub PAT，测试必须使用 ghp_test... 占位符",
    check: (match) => {
      return !/test|mock|sample|xxx/i.test(match);
    },
  },
  {
    id: "SEC-005-PRIVATE-KEY",
    name: "未 Mock 的真实私钥证书",
    regex: /-----BEGIN\s+(?:OPENSSH|RSA|EC|DSA|PGP)?\s*PRIVATE KEY-----/g,
    suggestion: "测试夹具中严禁写入真实私钥，私钥行必须包含 MOCK_KEY_DATA 或 ...test key...",
    check: (_match, line, fileContent) => {
      if (line.includes("MOCK_KEY_DATA") || line.includes("...test key...") || line.includes("mockPrivateKey") || line.includes("...")) {
        return false;
      }
      if (fileContent && (fileContent.includes("MOCK_KEY_DATA") || fileContent.includes("...test key...") || fileContent.includes("..."))) {
        return false;
      }
      return true;
    },
  },
  {
    id: "SEC-006-HARDCODED-PASSWORD",
    name: "硬编码管理员/平台密码",
    regex: /(?:WEB_ADMIN_PASSWORD|ADMIN_PASSWORD|admin_password)\s*[:=]\s*["']([^"']+)["']/g,
    suggestion: "密码必须使用 your_secure_password_here、<ADMIN_PASSWORD> 或从环境变量中动态读取",
    check: (_match, _line, _fc, capture) => {
      const val = (capture || "").trim();
      if (!val || val === "your_secure_password_here" || val === "<ADMIN_PASSWORD>") return false;
      if (val.startsWith("$") || val.startsWith("process.env")) return false;
      return true;
    },
  },
  {
    id: "SEC-007-FORBIDDEN-INTERNAL-IP",
    name: "非标开发宿主 IP 或私有非标 SSH 端口",
    regex: new RegExp("\\b(?:10\\.126\\.\\d+\\.\\d+|DEPLOY_" + "PORT=(?!22\\b)\\d+)\\b", "g"),
    suggestion: "严禁提交开发宿主私网 IP (10.126.*.*) 或非标端口，请使用 127.0.0.1 或 192.168.1.100 与端口 22",
    check: () => true,
  },
  {
    id: "SEC-008-EASYTIER-TUNNEL-SECRET",
    name: "未脱敏 EasyTier 组网密钥",
    regex: /network_secret\s*[:=]\s*["']([^"']+)["']/g,
    suggestion: "EasyTier 组网密钥必须使用规范占位符 network_secret = \"demo_secret_token\"",
    check: (_match, _line, _fc, capture) => {
      const val = (capture || "").trim();
      return val !== "demo_secret_token" && val !== "<NETWORK_SECRET>" && val !== "" && !val.startsWith("$");
    },
  },
  {
    id: "SEC-009-SENSITIVE-SLUG-OR-ZONE",
    name: "真实用户子域 Slug 或 Cloudflare Zone ID",
    regex: /\b(?:dirtyfancy\.mediaryconnect\.app|cf_zone_0123456789abcdef0123456789abcdef)\b/g,
    suggestion: "请使用规范示例子域 demo-slug.mediaryconnect.app 或 RFC 5737 域名与虚拟 Zone ID",
    check: () => true,
  },
];

const IGNORED_PATH_PATTERNS = [
  /^[\\/]?(?:\.git|\.next|node_modules|dist|coverage|\.omo|data|run|docs_secret|[\\/]\.git|[\\/]\.next)[\\/]/i,
  /tools[\\/]gates[\\/]check-security-credentials\.mjs$/i,
  /tools[\\/]gates[\\/]check-security-credentials\.test\.mjs$/i,
  /docs[\\/]architecture[\\/]security-credential-governance-and-git-hook-gate-spec\.md$/i,
  /tools[\\/]gates[\\/]security-suppressions\.json$/i,
  /\.dependency-cruiser-known-violations\.json$/i,
  /eslint-suppressions\.json$/i,
  /(?:package-lock\.json|pnpm-lock\.yaml)$/i,
];

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".svg",
  ".mp4", ".webm", ".mp3", ".wav", ".woff", ".woff2", ".ttf",
  ".eot", ".db", ".sqlite", ".sqlite3", ".tar", ".gz", ".zip",
  ".pdf", ".node", ".exe", ".dll", ".so", ".bin"
]);

export function isPathIgnored(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  const ext = path.extname(normalized).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  return IGNORED_PATH_PATTERNS.some((pat) => pat.test(normalized));
}

/** 加载基线抑制配置 */
export function loadSuppressions() {
  if (!fs.existsSync(suppressionsPath)) return {};
  try {
    const raw = fs.readFileSync(suppressionsPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`${c.yellow}⚠ 警告：无法解析 security-suppressions.json：${err.message}${c.reset}`);
    return {};
  }
}

/** 检查单行是否存在抑制注释 */
function isLineSuppressed(line, prevLine) {
  if (/\b(?:security-disable-line|security-ignore-line)\b/.test(line)) return true;
  if (prevLine && /\b(?:security-disable-next-line|security-ignore-next-line)\b/.test(prevLine)) return true;
  return false;
}

/**
 * 核心检查函数：分析文件内容并返回违规列表
 * @param {string} relativePath 相对仓库根目录路径
 * @param {string} content 文件内容文本
 * @param {object} suppressions 基线映射
 * @param {Array<{ lineNum: number, lineText: string }>} [targetLines] 可选的指定行集合（用于增量扫描）
 */
export function analyzeContent(relativePath, content, suppressions = {}, targetLines = null) {
  const normPath = relativePath.replace(/\\/g, "/");
  const fileSuppressions = suppressions[normPath] || {};
  const violations = [];

  const lines = content.split(/\r?\n/);
  const lineRecords = targetLines ?? lines.map((lineText, idx) => ({ lineNum: idx + 1, lineText }));

  for (let i = 0; i < lineRecords.length; i++) {
    const { lineNum, lineText } = lineRecords[i];
    const prevLineText = lineNum > 1 ? lines[lineNum - 2] : null;

    if (isLineSuppressed(lineText, prevLineText)) {
      continue;
    }

    for (const rule of DETECTOR_RULES) {
      if (fileSuppressions[rule.id]) {
        continue;
      }

      // 重置正则
      rule.regex.lastIndex = 0;
      let match;
      while ((match = rule.regex.exec(lineText)) !== null) {
        const fullMatch = match[0];
        const capture = match[1] || "";

        // 占位符豁免
        if (COMPLIANT_PLACEHOLDERS.some((p) => p.test(fullMatch))) {
          continue;
        }

        const isViolation = rule.check ? rule.check(fullMatch, lineText, content, capture) : true;
        if (isViolation) {
          violations.push({
            file: normPath,
            line: lineNum,
            ruleId: rule.id,
            ruleName: rule.name,
            suggestion: rule.suggestion,
            snippet: lineText.trim(),
            match: fullMatch,
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Git 暂存区差异适配器：提取所有本次暂存的新增/修改行
 */
export function getStagedDiffTargets() {
  const diffOutput = execSync("git diff --cached -U0", { cwd: repoRoot, encoding: "utf8" });
  if (!diffOutput.trim()) return [];

  const targets = [];
  const fileSections = diffOutput.split(/^diff --git /m);

  for (const section of fileSections) {
    if (!section.trim()) continue;

    // 提取目标路径
    const matchFile = section.match(/^\+\+\+ b\/(.+)$/m);
    if (!matchFile) continue;
    const filePath = matchFile[1].trim();

    if (isPathIgnored(filePath)) continue;

    const absPath = path.join(repoRoot, filePath);
    if (!fs.existsSync(absPath)) continue;

    const fullContent = fs.readFileSync(absPath, "utf8");
    const addedLines = [];

    // 解析 @@ -X,Y +LINE,COUNT @@
    const hunkHeaderRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
    let hunkHeader;
    let lastIndex = 0;

    const lines = section.split("\n");
    let currentLineNum = 0;
    let isTracking = false;

    for (const l of lines) {
      if (l.startsWith("@@ ")) {
        const m = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
        if (m) {
          currentLineNum = parseInt(m[1], 10);
          isTracking = true;
          continue;
        }
      }

      if (isTracking) {
        if (l.startsWith("+") && !l.startsWith("+++")) {
          addedLines.push({
            lineNum: currentLineNum,
            lineText: l.substring(1),
          });
          currentLineNum++;
        } else if (!l.startsWith("-")) {
          currentLineNum++;
        }
      }
    }

    if (addedLines.length > 0) {
      targets.push({
        filePath,
        content: fullContent,
        addedLines,
      });
    }
  }

  return targets;
}

/**
 * 全量仓库文件适配器：遍历所有非忽略文件
 */
export function getAllRepoFiles() {
  const output = execSync("git ls-files --cached --others --exclude-standard", {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return output
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !isPathIgnored(s));
}

/** 执行门禁质检的主逻辑 */
export function runSecurityInspection(isStaged = false) {
  const suppressions = loadSuppressions();
  const allViolations = [];
  const startTime = Date.now();

  if (isStaged) {
    const stagedTargets = getStagedDiffTargets();
    for (const target of stagedTargets) {
      const v = analyzeContent(target.filePath, target.content, suppressions, target.addedLines);
      allViolations.push(...v);
    }
  } else {
    const files = getAllRepoFiles();
    for (const file of files) {
      const absPath = path.join(repoRoot, file);
      if (!fs.existsSync(absPath)) continue;
      let content;
      try {
        content = fs.readFileSync(absPath, "utf8");
      } catch {
        continue; // 忽略不可读文件
      }
      const v = analyzeContent(file, content, suppressions);
      allViolations.push(...v);
    }
  }

  const durationMs = Date.now() - startTime;
  return { violations: allViolations, durationMs };
}

// CLI 执行入口
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const isStaged = process.argv.includes("--staged");
  const { violations: resultViolations, durationMs } = runSecurityInspection(isStaged);

  if (resultViolations.length > 0) {
    console.error(`\n${c.red}${c.bold}✖ [Security Gate Violation] 检测到 ${resultViolations.length} 处凭据/地址安全违规！${c.reset}`);
    for (const v of resultViolations) {
      console.error(`  ${c.red}→ ${v.file}:${v.line}${c.reset} [${c.yellow}${v.ruleId}${c.reset}] ${v.ruleName}`);
      console.error(`    ${c.yellow}违规代码:${c.reset} ${v.snippet}`);
      console.error(`    ${c.cyan}合规指引:${c.reset} ${v.suggestion}`);
    }
    console.error(`\n${c.yellow}💡 请修正上述违规项后再行提交。详细规范参见 docs/architecture/security-credential-governance-and-git-hook-gate-spec.md${c.reset}\n`);
    process.exit(1);
  } else {
    const modeLabel = isStaged ? "Git 暂存区增量" : "全仓库";
    console.log(`${c.green}✔ [Security Gate] ${modeLabel}凭据安全与脱敏门禁质检通过：0 项违规 (耗时 ${durationMs}ms)${c.reset}`);
    process.exit(0);
  }
}
