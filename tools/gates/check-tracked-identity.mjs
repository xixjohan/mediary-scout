#!/usr/bin/env node
/**
 * 巡影 · Mediary Scout 「合成标题不得冒充作品」门禁 (Tracked Identity Gate)
 *
 * 缺陷原型（2026-11-19 生产实测）：站长「关键字投放」在只给关键字时，用合成
 * `MediaTitle`（`tmdbId: 0`、id 形如 `owner_ingest_<storage>_<keyword>`）承载 run
 * 记录——那是投放**记录**，不是作品。但「已追踪季」读取层只排掉了 `resource_search`，
 * 于是它出现在影视库海报墙（卡片「骚货 · 0 已获 0/2 集」）、被每日巡检当成电影去
 * `movie_init`（白烧一次 LLM + 搜索），点进去落在 `/show/0` 并在
 * `buildMovieCandidateId` 抛「movie candidate id 必须是正整数，收到 0」，整页 500。
 *
 * 这类 bug 的共性是「新增了一个无身份的写入方，但读取/花费/渲染路径默认它一定有身份」。
 * 本门禁静态堵住四条最关键的通路。
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
  console.error(`${c.red}✖ [Tracked Identity Gate Violation]${c.reset} ${path.relative(repoRoot, file)}`);
  console.error(`  ${c.yellow}原因:${c.reset} ${message}`);
  violations++;
}

/** 去掉注释：文档里提到这些符号是允许的（那是缺陷记录），代码里出现才是接线。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readCode(rel) {
  const full = path.join(repoRoot, rel);
  if (!fs.existsSync(full)) {
    reportViolation(full, "文件不存在：身份闸门无处落地。");
    return null;
  }
  return stripComments(fs.readFileSync(full, "utf8"));
}

/** 取出某个函数的**函数体**（不含参数表）。
 *
 *  先跳过参数表的括号，再找参数表之后第一个 `{` 作为函数体起点——直接把第一个 `{`
 *  当函数体会返回参数的类型字面量（多行参数对象的 `{}` 恰好闭合在那里），
 *  于是函数体检查永远看不到真正的实现。 */
function functionBody(code, marker) {
  const start = code.indexOf(marker);
  if (start < 0) return null;
  const parenStart = code.indexOf("(", start);
  if (parenStart < 0) return null;
  let parenDepth = 0;
  let afterParams = -1;
  for (let index = parenStart; index < code.length; index += 1) {
    const ch = code[index];
    if (ch === "(") parenDepth += 1;
    else if (ch === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        afterParams = index;
        break;
      }
    }
  }
  if (afterParams < 0) return null;
  const braceStart = code.indexOf("{", afterParams);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let index = braceStart; index < code.length; index += 1) {
    const ch = code[index];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(braceStart, index + 1);
    }
  }
  return null;
}

// ============================================================================
// 1. 判据本体必须存在且两个条件都在
//
// 判据放在独立文件 `domain/tracked-identity.ts`：`domain.ts` 已顶到 600 行上限，
// 塞进去会同时触发「文件超长」与「既有棘轮」两条门禁。
// ============================================================================
function checkIdentityPredicate() {
  const rel = "packages/workflow/src/domain/tracked-identity.ts";
  const code = readCode(rel);
  if (code === null) return;
  if (!code.includes("export function isTrackedTitleIdentity")) {
    reportViolation(
      rel,
      "缺少 isTrackedTitleIdentity()：读取层将重新用「只排 resource_search」的旧判据，合成标题会再次进影视库。",
    );
    return;
  }
  if (!code.includes("SYNTHETIC_TITLE_ID_PREFIX")) {
    reportViolation(
      rel,
      "缺少 SYNTHETIC_TITLE_ID_PREFIX：合成前缀是第二份硬编码，换命名会一边改一边漏。",
    );
  }
  const body = functionBody(code, "export function isTrackedTitleIdentity");
  if (body === null) return;
  if (!/tmdbId\s*<=\s*0/.test(body)) {
    reportViolation(rel, "isTrackedTitleIdentity 未校验 tmdbId > 0：哨兵 0 会被当成作品。");
  }
  if (!body.includes("startsWith") && !body.includes("SYNTHETIC_TITLE_ID_PREFIX")) {
    reportViolation(
      rel,
      "isTrackedTitleIdentity 未排除合成前缀：未来出现「带假 id 的合成标题」时会静默放行。",
    );
  }
}

// ============================================================================
// 2. 读取层必须真的收口（四个入口）
// ============================================================================
const READ_PATHS = [
  {
    file: "packages/workflow/src/persistence/sqlite.ts",
    markers: [
      "async getTrackedSeasonState(",
      "async listTrackedSeasonStates(",
      "async listAllTrackedSeasonStates(",
    ],
  },
  {
    file: "packages/workflow/src/persistence/repository.ts",
    markers: [
      "async getTrackedSeasonState(",
      "async listTrackedSeasonStates(",
      "async listAllTrackedSeasonStates(",
    ],
  },
];

function checkReadLayer() {
  for (const entry of READ_PATHS) {
    const code = readCode(entry.file);
    if (code === null) continue;
    for (const marker of entry.markers) {
      const body = functionBody(code, marker);
      if (body === null) {
        reportViolation(entry.file, `找不到 ${marker}：读取入口被删/改名，身份收口随之失效。`);
        continue;
      }
      if (!body.includes("isTrackedTitleIdentity")) {
        reportViolation(
          entry.file,
          `${marker.replace("async ", "").replace("(", "")} 未经过 isTrackedTitleIdentity：合成标题会重新出现在影视库/巡检/详情页。`,
        );
      }
    }
  }
}

// ============================================================================
// 3. 巡检必须拒绝无身份作品（唯一花真钱的消费者）
// ============================================================================
function checkPatrolGuard() {
  const code = readCode("packages/workflow/src/execution/worker.ts");
  if (code === null) return;
  const marker = 'if (s.title.type === "movie")';
  const start = code.indexOf(marker);
  if (start < 0) {
    reportViolation("packages/workflow/src/execution/worker.ts", "找不到巡检电影分支：身份防御的位置已变，需人工复核。");
    return;
  }
  // 分支体内（到下一个 `} else {` 或配套的收尾）必须出现判据。
  const slice = code.slice(start, start + 900);
  if (!slice.includes("isTrackedTitleIdentity")) {
    reportViolation(
      "packages/workflow/src/execution/worker.ts",
      "巡检电影分支未校验身份：会对 tmdbId=0 的记录发起 movie_init，白烧一次 LLM + 搜索。",
    );
  }
}

// ============================================================================
// 4. 排队入口必须拒绝无身份标题（在花钱之前失败）
// ============================================================================
function checkQueueGuard() {
  const code = readCode("packages/workflow/src/execution/commands.ts");
  if (code === null) return;
  const body = functionBody(code, "export async function queueMovieAcquisition(");
  if (body === null) {
    reportViolation("packages/workflow/src/execution/commands.ts", "找不到 queueMovieAcquisition：排队守卫无处落地。");
    return;
  }
  if (!/tmdbId\s*<=\s*0/.test(body) && !body.includes("正整数")) {
    reportViolation(
      "packages/workflow/src/execution/commands.ts",
      "queueMovieAcquisition 未校验 tmdbId：无身份标题会被排队，直到渲染层才炸。",
    );
  }
}

// ============================================================================
// 5. 渲染层必须把非法 id 挡在 getDetailView 之前
// ============================================================================
function checkRenderGuard() {
  const code = readCode("apps/web/features/catalog/core/show-page-params.ts");
  if (code === null) return;
  if (!code.includes("export function parseTmdbIdParam")) {
    reportViolation(
      "apps/web/features/catalog/core/show-page-params.ts",
      "缺少 parseTmdbIdParam：`/show/0` 会通过 Number.isInteger 检查直达渲染层并 500。",
    );
    return;
  }
  const body = functionBody(code, "export function parseTmdbIdParam");
  if (body === null) return;
  if (!/value\s*>\s*0/.test(body)) {
    reportViolation(
      "apps/web/features/catalog/core/show-page-params.ts",
      "parseTmdbIdParam 未校验 > 0：哨兵 0 会被当成合法 id。",
    );
  }

  const pageCode = readCode("apps/web/app/show/[tmdbId]/page.tsx");
  if (pageCode === null) return;
  if (!pageCode.includes("parseTmdbIdParam")) {
    reportViolation(
      "apps/web/app/show/[tmdbId]/page.tsx",
      "页面未消费 parseTmdbIdParam：非法 id 的守卫没有接上。",
    );
  }
  if (!pageCode.includes("ShowNotFound")) {
    reportViolation(
      "apps/web/app/show/[tmdbId]/page.tsx",
      "页面未使用 ShowNotFound：非法 id 与「查不到」的空态无法区分。",
    );
  }
}

export function runTrackedIdentityGate() {
  violations = 0;
  console.log(`${c.cyan}${c.bold}▶ 正在执行「合成标题不得冒充作品」门禁...${c.reset}`);

  checkIdentityPredicate();
  checkReadLayer();
  checkPatrolGuard();
  checkQueueGuard();
  checkRenderGuard();

  if (violations > 0) {
    console.error(`\n${c.red}${c.bold}✖ 门禁未通过，发现 ${violations} 处「无身份记录冒充作品」的风险！${c.reset}\n`);
    return false;
  }
  console.log(
    `${c.green}${c.bold}✔ 「合成标题不得冒充作品」门禁通过（判据就位、读取层收口、巡检/排队/渲染三层守卫在线）${c.reset}\n`,
  );
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(runTrackedIdentityGate() ? 0 : 1);
}
