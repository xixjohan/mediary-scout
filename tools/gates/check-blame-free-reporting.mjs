#!/usr/bin/env node
/**
 * 巡影 · Mediary Scout 「别甩锅」报告完整性门禁 (Blame-Free Reporting Gate)
 *
 * 核心命题：**一个「什么都没拿到」的运行，绝不能因为没人分类就说成「资源不存在」。**
 *
 * 缺陷原型（2026-11-18 生产实测，《咒术回战 第 1 季》）：
 *   resource_filter_applied { inputCount: 82, keptCount: 77, sourceStatus: "healthy" }
 *   loop_stopped            { stopReason: "model_error", steps: 1 }
 * 搜索取回 82 条、准入 77 条、源健康，但 LLM 第一步就报错（**不抛错**），
 * 集数算术看到「一集没进库」判 no_coverage，用户读到「暂未找到可用资源」——
 * 而同一订阅在「预览」里能看到资源。
 *
 * 这类 bug 的共性是「新增了一种系统故障，但忘了加进诚实通道」。四条已存在的
 * 分类器（账号封锁 / 搜索源故障 / 规则全排除 / 智能体异常）只要少接一条，
 * 那一类故障就会静默退化成内容事实。本门禁静态堵住这种退化。
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

function reportViolation(file, message) {
  console.error(`${c.red}✖ [Blame-Free Gate Violation]${c.reset} ${path.relative(repoRoot, file)}`);
  console.error(`  ${c.yellow}原因:${c.reset} ${message}`);
  violations++;
}

/** 去掉注释：文档里提到这些名字是允许的（那是缺陷记录），代码里出现才是接线。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** 行号查找（1 基）；找不到返回 -1。 */
function lineOf(content, needle) {
  const index = content.indexOf(needle);
  return index < 0 ? -1 : content.slice(0, index).split("\n").length;
}

// ============================================================================
// 1. 四种「不是资源的问题」的分类器必须齐备
// ============================================================================
const CLASSIFIERS = [
  { file: "packages/workflow/src/acquisition-v2/transfer-block.ts", symbol: "classifyTransferBlock", label: "账号被封锁(配额/登录/VIP/盘满)" },
  { file: "packages/workflow/src/acquisition-v2/search-source-fault.ts", symbol: "classifySearchSourceFault", label: "搜索源连不上/协议不符" },
  { file: "packages/workflow/src/acquisition-v2/search-filter-diagnostics.ts", symbol: "searchFilterFailureReason", label: "候选全被订阅规则排除" },
  { file: "packages/workflow/src/acquisition-v2/agent-fault.ts", symbol: "classifyAgentFault", label: "智能体循环异常终止(model_error)" },
];

function checkClassifiersExist() {
  for (const entry of CLASSIFIERS) {
    const full = path.join(repoRoot, entry.file);
    if (!fs.existsSync(full)) {
      reportViolation(full, `缺少「${entry.label}」的分类器：这类系统故障会静默退化成「暂未找到可用资源」。`);
      continue;
    }
    const code = stripComments(fs.readFileSync(full, "utf8"));
    if (!code.includes(`export function ${entry.symbol}`)) {
      reportViolation(full, `未导出 ${entry.symbol}()：分类器被删/改名后，接线会静默失效。`);
    }
  }
}

// ============================================================================
// 2. 两个消费点必须真的 import 并调用（删掉一行 = 那一类故障重新开始撒谎）
//
// 注意两条路径的落地方式不同：
//   · bridge 把 reason 传给 buildSeasonReport / buildSeriesReport / buildReplacementReport，
//     由那些 builder 内部调 emptyRunOutcome（所以它自己不出现 emptyRunOutcome 字样）；
//   · movie workflow 直接调 emptyRunOutcome。
// 共同点是**reason 必须被继续往下传**——检查 `agentFaultReason:` 这个实参即可。
// ============================================================================
const CONSUMERS = [
  "packages/workflow/src/acquisition-v2/workflow-v2-bridge.ts",
  "packages/workflow/src/execution/movie-workflow-v2.ts",
];

function checkConsumersWired() {
  for (const rel of CONSUMERS) {
    const full = path.join(repoRoot, rel);
    if (!fs.existsSync(full)) continue;
    const code = stripComments(fs.readFileSync(full, "utf8"));
    for (const entry of CLASSIFIERS) {
      if (!code.includes(entry.symbol)) {
        reportViolation(
          full,
          `未调用 ${entry.symbol}()：「${entry.label}」这一类故障会重新被报成「暂未找到可用资源」。`,
        );
      }
    }
    // 分类器的结果必须真的往下传，否则调用只是「读了没接」。
    if (!code.includes("agentFaultReason:")) {
      reportViolation(full, "agentFaultReason 未传给报告构造：分类结果读了却没有落地。");
    }
  }
}

// ============================================================================
// 3. no_coverage 兜底必须排在所有故障分支之后
//
// 这是最隐蔽的一种退化：有人把新分支**追加到** return 之后（或提前 return），
// 前面所有分类器照常工作，但永远不会被读到。用行号比较堵住。
// ============================================================================
function checkFallbackOrder() {
  const full = path.join(repoRoot, "packages/workflow/src/domain/notification-report.ts");
  if (!fs.existsSync(full)) {
    reportViolation(full, "notification-report.ts 不存在：诚实报告的单一出口缺失。");
    return;
  }
  const code = stripComments(fs.readFileSync(full, "utf8"));
  const start = code.indexOf("export function emptyRunOutcome");
  if (start < 0) {
    reportViolation(full, "未找到 emptyRunOutcome：诚实报告的单一出口被删/改名。");
    return;
  }
  const bodyStart = code.indexOf("{", start);
  const bodyEnd = code.indexOf("\n}", bodyStart);
  const body = code.slice(bodyStart, bodyEnd < 0 ? code.length : bodyEnd);

  const fallbackLine = body.indexOf('status: "no_coverage"');
  if (fallbackLine < 0) {
    reportViolation(full, "emptyRunOutcome 里找不到 no_coverage 兜底：真·无覆盖将无从表达。");
    return;
  }
  for (const branch of ["transferBlockReason", "searchSourceFaultReason", "searchFilterReason", "agentFaultReason"]) {
    const branchLine = body.indexOf(branch);
    if (branchLine < 0) {
      reportViolation(full, `emptyRunOutcome 缺少 ${branch} 分支：这一类故障重新开始撒谎。`);
      continue;
    }
    if (branchLine > fallbackLine) {
      reportViolation(
        full,
        `${branch} 分支排在 no_coverage 兜底之后：分类器照常工作但永远不会被读到（提前 return）。`,
      );
    }
  }
}

// ============================================================================
// 4. loop_stopped 必须继续携带 stopReason
//
// 整条链读的就是这个字段。orchestrator 一旦不再写它，classifyAgentFault
// 会永远返回 null，门禁 1–3 全部通过却毫无作用。
// ============================================================================
function checkStopReasonPersisted() {
  const full = path.join(repoRoot, "packages/workflow/src/acquisition-v2/orchestrator.ts");
  if (!fs.existsSync(full)) {
    reportViolation(full, "orchestrator.ts 不存在：智能体停止原因无处产生。");
    return;
  }
  const code = stripComments(fs.readFileSync(full, "utf8"));
  const index = code.indexOf('type: "loop_stopped"');
  if (index < 0) {
    reportViolation(full, 'orchestrator 不再产生 loop_stopped 审计事件：classifyAgentFault 永远读不到证据。');
    return;
  }
  // 事件对象附近（同一条 push 调用内）必须出现 stopReason。
  const nearby = code.slice(index, index + 400);
  if (!nearby.includes("stopReason")) {
    reportViolation(full, "loop_stopped 事件未携带 stopReason：本条链路的唯一证据字段缺失。");
  }
}

// ============================================================================
// 5. agent_error 与 no_coverage 在 UI 上必须可分
//
// 通知页顶部的「N 项暂无资源」只数 no_coverage；若 agent_error 没被单独登记，
// 它就会退回默认图标/文案，用户看不出「AI 挂了」与「确实没有」的区别。
// ============================================================================
function checkUiDistinguishable() {
  const full = path.join(repoRoot, "apps/web/app/notifications/page.tsx");
  if (!fs.existsSync(full)) {
    reportViolation(full, "通知页不存在。");
    return;
  }
  const code = stripComments(fs.readFileSync(full, "utf8"));
  if (!code.includes("agent_error")) {
    reportViolation(full, "通知页未登记 agent_error：AI 异常会显示成「暂无资源」的样式，两者在视觉上不可分。");
  }
  // 摘要里的计数必须以 no_coverage 为准，不能把 agent_error 也算进去。
  const summaryIndex = code.indexOf("function daySummary");
  if (summaryIndex >= 0) {
    const summaryBody = code.slice(summaryIndex, summaryIndex + 1200);
    if (!summaryBody.includes('kind === "no_coverage"')) {
      reportViolation(
        full,
        "daySummary 不再按 no_coverage 计数：AI 异常/转存失败会被算进「N 项暂无资源」，等于换了个地方撒谎。",
      );
    }
  }
}

// ============================================================================
// 6. 分类器模块必须被包入口导出（否则 app 侧无法复用，接线只能复制粘贴）
// ============================================================================
function checkPackageExport() {
  const full = path.join(repoRoot, "packages/workflow/src/index.ts");
  if (!fs.existsSync(full)) return;
  const code = stripComments(fs.readFileSync(full, "utf8"));
  if (!code.includes("./acquisition-v2/agent-fault.js")) {
    reportViolation(full, "包入口未导出 agent-fault：app 侧无法复用分类器，接线容易长出第二份实现。");
  }
}

export function runBlameFreeReportingGate() {
  violations = 0;
  console.log(`${c.cyan}${c.bold}▶ 正在执行「别甩锅」报告完整性门禁...${c.reset}`);

  checkClassifiersExist();
  checkConsumersWired();
  checkFallbackOrder();
  checkStopReasonPersisted();
  checkUiDistinguishable();
  checkPackageExport();

  if (violations > 0) {
    console.error(`\n${c.red}${c.bold}✖ 门禁未通过，发现 ${violations} 处「系统故障被报成内容事实」的风险！${c.reset}\n`);
    return false;
  }
  console.log(`${c.green}${c.bold}✔ 「别甩锅」报告完整性门禁通过（四类故障分类器齐备、接线完整、兜底顺序正确、证据字段在线）${c.reset}\n`);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(runBlameFreeReportingGate() ? 0 : 1);
}

export { lineOf };
