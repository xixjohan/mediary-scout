#!/usr/bin/env node
/**
 * 全屏铺满门禁（Fullscreen Viewport Gate）
 *
 * 守护的不变量：**只要根元素预留了滚动条槽位，全屏就必须把槽位宽度还回去**。
 *
 * 背景（2026-11-16 线上问题）：`reset.css` 给 `html` 设了
 * `scrollbar-gutter: stable`，用以消除「有/无滚动条」切换时的页面抖动。但该
 * 属性即使没有滚动条也常驻预留一条槽位，而全屏元素的 `width:100%`（原生
 * 全屏）和 `100vw`（viewport 单位同样被槽位扣减）都按「视口宽 - 槽宽」解析，
 * 于是右侧露出 15px 页面底色 —— 观感就是「全屏右侧有黑边」。
 * `overflow:hidden` 只是不画滚动条，**仍然预留槽位**，所以它单独存在时并不能
 * 修好这个问题（这次线上回归正是「以为 overflow 够了」）。
 *
 * 检查项：
 *   1. [Gutter Reset Exists] 若根级样式声明了 scrollbar-gutter（stable /
 *      both-edges），globals.css 必须存在 `html.mediary-fullscreen` 规则且
 *      同时复位 `scrollbar-gutter: auto` 与 `overflow: hidden`；
 *   2. [Web Fullscreen Coverage] 该规则下 `.art-video-player.art-fullscreen-web`
 *      必须以 `100vw / 100vh` 覆盖视口（网页全屏不走原生 Fullscreen API，
 *      `100%` 会继续被槽位扣减）；
 *   3. [Native Fullscreen Wired] 播放器核心必须订阅 `document` 的
 *      `fullscreenchange`（原生全屏只有 document 级事件，没有 ArtPlayer 事件），
 *      与 `fullscreenWeb` 共用同一个 html 类名状态，并在卸载时移除监听 + 清类。
 *
 * 退出码：0 = 全部通过；1 = 发现违规。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const globalsCssPath = join(root, "apps/web/app/globals.css");
const resetCssPath = join(root, "apps/web/design-system/foundations/reset.css");
const playerCorePath = join(root, "apps/web/features/player/components/mediary-player-core.tsx");

/** 根级全屏状态类名（网页全屏与原生全屏共用）。 */
export const FULLSCREEN_ROOT_CLASS = "mediary-fullscreen";

/** 去掉 CSS 注释，避免注释里的示例文本被误判为真实声明。 */
export function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 从 CSS 文本里抽出匹配选择器的声明块（支持逗号分隔的多选择器）。 */
export function findRuleBlocks(css, selectorPattern) {
  const clean = stripCssComments(css);
  const blocks = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(clean)) !== null) {
    const selectors = match[1]
      .split(",")
      .map((part) => part.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    if (selectors.some((selector) => selectorPattern.test(selector))) {
      blocks.push({ selectors, body: match[2] });
    }
  }
  return blocks;
}

function declares(body, property) {
  return new RegExp(`(^|;)\\s*${property}\\s*:`, "m").test(body);
}

function readValue(body, property) {
  const match = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "m"));
  return match ? match[1].trim().replace(/\s+/g, " ") : null;
}

/**
 * 纯函数审核器：输入三份源码文本，输出违规清单（空数组 = 通过）。
 * 抽成无 IO 形态是为了让单测能喂合成输入，覆盖「有人把 gutter 复位删掉」这类回归。
 */
export function auditFullscreenContract({ globalsCss, resetCss, playerCore }) {
  const problems = [];
  // null/undefined = 文件缺失；空字符串是合法输入（用于「没有根级 gutter」的用例）。
  if (globalsCss === null || globalsCss === undefined) {
    return ["缺少核心样式文件 apps/web/app/globals.css"];
  }
  if (playerCore === null || playerCore === undefined) {
    return ["缺少播放器核心组件 mediary-player-core.tsx"];
  }

  const rootReservesGutter =
    (resetCss ?? "").match(/(^|[;{])\s*scrollbar-gutter\s*:\s*(stable|both-edges)/m) !== null ||
    [...findRuleBlocks(globalsCss, /^html\s*$/), ...findRuleBlocks(globalsCss, /^:root\s*$/)].some(
      (rule) => {
        const value = readValue(rule.body, "scrollbar-gutter");
        return value !== null && value !== "auto";
      },
    );

  if (rootReservesGutter) {
    const fullscreenRules = findRuleBlocks(
      globalsCss,
      new RegExp(`^html\\.${FULLSCREEN_ROOT_CLASS}$`),
    );
    if (fullscreenRules.length === 0) {
      problems.push(
        `[Gutter Reset Exists] 根元素声明了 scrollbar-gutter: stable（消除布局抖动的正当诉求），` +
          `但 globals.css 缺少 \`html.${FULLSCREEN_ROOT_CLASS}\` 规则。` +
          `后果：全屏宽 = 视口宽 - 槽位宽，右侧固定露出约 15px 黑边。` +
          `修复：新增 \`html.${FULLSCREEN_ROOT_CLASS} { overflow: hidden; scrollbar-gutter: auto; }\`。`,
      );
    } else {
      const body = fullscreenRules.map((rule) => rule.body).join(";");
      const gutterValue = readValue(body, "scrollbar-gutter");
      if (gutterValue === null) {
        problems.push(
          `[Gutter Reset Exists] html.${FULLSCREEN_ROOT_CLASS} 未复位 scrollbar-gutter：` +
            `只写 overflow:hidden 不够，槽位仍预留，全屏右侧继续露底色。修复：补 \`scrollbar-gutter: auto;\`。`,
        );
      } else if (gutterValue !== "auto") {
        problems.push(
          `[Gutter Reset Exists] html.${FULLSCREEN_ROOT_CLASS} 的 scrollbar-gutter 必须是 auto，当前为 ${gutterValue}。`,
        );
      }
      if (!declares(body, "overflow")) {
        problems.push(
          `[Gutter Reset Exists] html.${FULLSCREEN_ROOT_CLASS} 缺少 overflow: hidden（全屏时背景页面仍可滚动）。`,
        );
      }

      const webRules = findRuleBlocks(
        globalsCss,
        new RegExp(`^html\\.${FULLSCREEN_ROOT_CLASS} \\.art-video-player\\.art-fullscreen-web$`),
      );
      if (webRules.length === 0) {
        problems.push(
          `[Web Fullscreen Coverage] 缺少 \`html.${FULLSCREEN_ROOT_CLASS} .art-video-player.art-fullscreen-web\` 规则；` +
            `ArtPlayer 只给容器写 width:100%/height:100%，无视口单位兜底时右侧会留缝。`,
        );
      } else {
        const webBody = webRules.map((rule) => rule.body).join(";");
        const width = readValue(webBody, "width");
        const height = readValue(webBody, "height");
        if (!width || !/100vw/.test(width)) {
          problems.push(
            `[Web Fullscreen Coverage] 网页全屏规则 width 必须是 100vw（当前 ${width ?? "未声明"}）。`,
          );
        }
        if (!height || !/100vh/.test(height)) {
          problems.push(
            `[Web Fullscreen Coverage] 网页全屏规则 height 必须是 100vh（当前 ${height ?? "未声明"}）。`,
          );
        }
      }
    }
  }

  const code = playerCore.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  if (!/addEventListener\(\s*["']fullscreenchange["']/.test(code)) {
    problems.push(
      "[Native Fullscreen Wired] 播放器核心未订阅 document 的 fullscreenchange 事件。" +
        "原生全屏（fullscreen / 系统手势 / F11）没有 ArtPlayer 事件，只能靠它同步 html 状态类；" +
        "否则退出后类名残留，页面会一直隐藏滚动条。",
    );
  }
  if (!/removeEventListener\(\s*["']fullscreenchange["']/.test(code)) {
    problems.push(
      "[Native Fullscreen Wired] 订阅了 fullscreenchange 却未在卸载时移除（内存泄漏 + 跨片残留）。",
    );
  }
  if (!new RegExp(`classList\\.toggle\\(\\s*["']${FULLSCREEN_ROOT_CLASS}["']`).test(code)) {
    problems.push(
      `[Native Fullscreen Wired] 必须通过 html.${FULLSCREEN_ROOT_CLASS} 单一类名表达全屏状态，` +
        `网页全屏与原生全屏共用，避免两套类名各自漏修。`,
    );
  }
  if (!new RegExp(`classList\\.remove\\(\\s*["']${FULLSCREEN_ROOT_CLASS}["']`).test(code)) {
    problems.push(
      `[Native Fullscreen Wired] 播放器卸载时必须 remove html.${FULLSCREEN_ROOT_CLASS}，否则离开播放器后页面仍隐藏滚动条。`,
    );
  }

  return problems;
}

function main() {
  const readIfExists = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);
  const problems = auditFullscreenContract({
    globalsCss: readIfExists(globalsCssPath),
    resetCss: readIfExists(resetCssPath),
    playerCore: readIfExists(playerCorePath),
  });

  if (problems.length > 0) {
    console.error("[Fullscreen Gate] 发现违规项：");
    for (const problem of problems) console.error(` - ${problem}`);
    process.exit(1);
  }
  console.log("[Fullscreen Gate] 全屏铺满门禁质检通过（0 处违规）");
}

// 直接执行才跑 IO；被 import 时只暴露纯函数。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
