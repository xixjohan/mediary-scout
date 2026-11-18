import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  auditFullscreenContract,
  findRuleBlocks,
  FULLSCREEN_ROOT_CLASS,
  stripCssComments,
} from "./check-fullscreen-viewport.mjs";

const GOOD_GLOBALS = `
html.${FULLSCREEN_ROOT_CLASS} {
  overflow: hidden;
  scrollbar-gutter: auto;
}
html.${FULLSCREEN_ROOT_CLASS} .art-video-player.art-fullscreen-web {
  width: 100vw !important;
  height: 100vh !important;
}
`;

const GOOD_RESET = `html { scrollbar-gutter: stable; }`;

const GOOD_PLAYER = `
const syncFullscreenClass = (on) => {
  document.documentElement.classList.toggle("${FULLSCREEN_ROOT_CLASS}", on);
};
document.addEventListener("fullscreenchange", handleFullscreenChange);
return () => {
  document.removeEventListener("fullscreenchange", handleFullscreenChange);
  document.documentElement.classList.remove("${FULLSCREEN_ROOT_CLASS}");
};
`;

describe("Fullscreen Viewport Gate", () => {
  it("passes on the actual repository with 0 violations", () => {
    const scriptPath = join(process.cwd(), "tools/gates/check-fullscreen-viewport.mjs");
    const output = execSync(`node "${scriptPath}"`, { encoding: "utf8" });
    expect(output).toContain("[Fullscreen Gate] 全屏铺满门禁质检通过");
  });

  it("accepts a complete contract", () => {
    expect(
      auditFullscreenContract({
        globalsCss: GOOD_GLOBALS,
        resetCss: GOOD_RESET,
        playerCore: GOOD_PLAYER,
      }),
    ).toEqual([]);
  });

  it("rejects overflow:hidden without scrollbar-gutter reset (the 2026-11-16 regression)", () => {
    const globals = `
      html.${FULLSCREEN_ROOT_CLASS} { overflow: hidden; }
      html.${FULLSCREEN_ROOT_CLASS} .art-video-player.art-fullscreen-web {
        width: 100vw !important;
        height: 100vh !important;
      }
    `;
    const problems = auditFullscreenContract({
      globalsCss: globals,
      resetCss: GOOD_RESET,
      playerCore: GOOD_PLAYER,
    });
    expect(problems.some((p) => p.includes("未复位 scrollbar-gutter"))).toBe(true);
  });

  it("rejects a missing fullscreen root rule entirely", () => {
    const problems = auditFullscreenContract({
      globalsCss: "html { scrollbar-gutter: stable; }",
      resetCss: GOOD_RESET,
      playerCore: GOOD_PLAYER,
    });
    expect(problems.some((p) => p.includes("[Gutter Reset Exists]"))).toBe(true);
  });

  it("rejects percentage-based web fullscreen sizing", () => {
    const globals = `
      html.${FULLSCREEN_ROOT_CLASS} { overflow: hidden; scrollbar-gutter: auto; }
      html.${FULLSCREEN_ROOT_CLASS} .art-video-player.art-fullscreen-web {
        width: 100% !important;
        height: 100% !important;
      }
    `;
    const problems = auditFullscreenContract({
      globalsCss: globals,
      resetCss: GOOD_RESET,
      playerCore: GOOD_PLAYER,
    });
    expect(problems.filter((p) => p.includes("[Web Fullscreen Coverage]")).length).toBe(2);
  });

  it("rejects a player that ignores native fullscreenchange", () => {
    const player = `
      const sync = (on) => document.documentElement.classList.toggle("${FULLSCREEN_ROOT_CLASS}", on);
      art.on("fullscreenWeb", sync);
    `;
    const problems = auditFullscreenContract({
      globalsCss: GOOD_GLOBALS,
      resetCss: GOOD_RESET,
      playerCore: player,
    });
    expect(problems.some((p) => p.includes("未订阅 document 的 fullscreenchange"))).toBe(true);
  });

  it("rejects a player that subscribes but never cleans up", () => {
    const player = `
      const sync = (on) => document.documentElement.classList.toggle("${FULLSCREEN_ROOT_CLASS}", on);
      document.addEventListener("fullscreenchange", () => sync(Boolean(document.fullscreenElement)));
      return () => { document.documentElement.classList.remove("${FULLSCREEN_ROOT_CLASS}"); };
    `;
    const problems = auditFullscreenContract({
      globalsCss: GOOD_GLOBALS,
      resetCss: GOOD_RESET,
      playerCore: player,
    });
    expect(problems.some((p) => p.includes("未在卸载时移除"))).toBe(true);
  });

  it("skips the gutter rules when the root does not reserve a gutter", () => {
    expect(
      auditFullscreenContract({
        globalsCss: "",
        resetCss: "html { margin: 0; }",
        playerCore: GOOD_PLAYER,
      }),
    ).toEqual([]);
  });

  it("stripCssComments ignores commented-out declarations", () => {
    const css = `/* html.med-scout { scrollbar-gutter: stable; } */ html { color: red; }`;
    expect(stripCssComments(css)).not.toContain("scrollbar-gutter");
  });

  it("findRuleBlocks matches multi-selector and descendant selectors", () => {
    const blocks = findRuleBlocks(
      GOOD_GLOBALS,
      new RegExp(`^html\\.${FULLSCREEN_ROOT_CLASS} \\.art-video-player\\.art-fullscreen-web$`),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].body).toContain("100vw");
  });
});
