import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * H1：更新链「四处同源」的行为级测试。
 *
 * 四处分别是：docker-compose.yml 的镜像默认值、updater/run-update.sh 的
 * UPDATE_REPO/IMAGE_BASE、scripts/deploy.sh 的镜像基址、apps/web 的
 * DEFAULT_UPDATE_REPO。前三处此前只有 updater 那一处有用例——compose 的推导
 * 与 deploy.sh 的默认值删掉后，全量 5195 用例照样全绿（第四轮复核实测）。
 *
 * 实跑推导段而不是文本匹配：把定义行抽出来执行，这样「在 IMAGE= 之后又偷偷
 * 覆盖」这类改动也会被测出来（行截取测不到，第四轮复核对 updater 的
 * probeDefaults 也提了同一意见）。
 */

const REPO_ROOT = new URL("../", import.meta.url).pathname;
const DEPLOY = readFileSync(join(REPO_ROOT, "scripts/deploy.sh"), "utf8");
const RUN_UPDATE = readFileSync(join(REPO_ROOT, "updater/run-update.sh"), "utf8");
const TAG = "v2026.10.02";

/** 抽出脚本里 [from, to] 两行之间的定义段，前面垫 TAG，末尾打印 $outVar。 */
function probe(script, from, to, outVar, env) {
  const lines = script.split("\n");
  const start = lines.findIndex((l) => l.startsWith(from));
  const end = lines.findIndex((l) => l.startsWith(to));
  expect(start, `update-source-parity: 必须有 ${from}`).toBeGreaterThanOrEqual(0);
  expect(end, `必须有 ${to}`).toBeGreaterThan(start);
  const snippet = ["#!/bin/sh", `TAG="${TAG}"`, ...lines.slice(start, end + 1), `printf '%s' "$${outVar}"`].join("\n");
  const dir = mkdtempSync(join(tmpdir(), "update-source-"));
  const file = join(dir, "probe.sh");
  writeFileSync(file, snippet);
  chmodSync(file, 0o755);
  return spawnSync(file, [], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" }).stdout;
}

describe("H1：更新链四处同源（默认都指当前仓库 xixjohan/mediary-scout）", () => {
  it("deploy.sh：镜像基址由更新源推导", () => {
    expect(probe(DEPLOY, '_UPDATE_REPO_RAW="', "IMAGE=", "IMAGE", {})).toBe(
      "ghcr.io/xixjohan/mediary-scout:" + TAG,
    );
  });

  it("deploy.sh：MEDIA_TRACK_UPDATE_REPO 覆盖时跟着改", () => {
    expect(probe(DEPLOY, '_UPDATE_REPO_RAW="', "IMAGE=", "IMAGE", { MEDIA_TRACK_UPDATE_REPO: "me/my-scout" })).toBe(
      "ghcr.io/me/my-scout:" + TAG,
    );
  });

  it("deploy.sh：MEDIA_IMAGE_BASE 仍可整体覆盖", () => {
    expect(probe(DEPLOY, '_UPDATE_REPO_RAW="', "IMAGE=", "IMAGE", { MEDIA_IMAGE_BASE: "ghcr.io/someone/else" })).toBe(
      "ghcr.io/someone/else:" + TAG,
    );
  });

  it("deploy.sh：镜像基址不再写死上游（H1 回归防线）", () => {
    expect(DEPLOY).not.toContain("MEDIA_IMAGE_BASE:-ghcr.io/fancydirty/mediary-scout");
  });

  it("run-update.sh：UPDATE_REPO 与 IMAGE_BASE 同样推导", () => {
    expect(probe(RUN_UPDATE, '_UPDATE_REPO_RAW="', "IMAGE_BASE=", "UPDATE_REPO", {})).toBe("xixjohan/mediary-scout");
    expect(probe(RUN_UPDATE, '_UPDATE_REPO_RAW="', "IMAGE_BASE=", "IMAGE_BASE", {})).toBe(
      "ghcr.io/xixjohan/mediary-scout",
    );
  });

  it("run-update.sh：env 覆盖两侧一起改", () => {
    const env = { MEDIA_TRACK_UPDATE_REPO: "me/my-scout" };
    expect(probe(RUN_UPDATE, '_UPDATE_REPO_RAW="', "IMAGE_BASE=", "UPDATE_REPO", env)).toBe("me/my-scout");
    expect(probe(RUN_UPDATE, '_UPDATE_REPO_RAW="', "IMAGE_BASE=", "IMAGE_BASE", env)).toBe("ghcr.io/me/my-scout");
  });

  it("两处脚本的默认值逐字相同（同源不是「各自猜一个」）", () => {
    const fromDeploy = /UPDATE_REPO="\$\{_UPDATE_REPO:-([^}]+)\}"/.exec(DEPLOY)?.[1];
    const fromUpdater = /UPDATE_REPO="\$\{_UPDATE_REPO:-([^}]+)\}"/.exec(RUN_UPDATE)?.[1];
    expect(fromDeploy, "deploy.sh 的默认更新源").toBe("xixjohan/mediary-scout");
    expect(fromUpdater, "run-update.sh 的默认更新源").toBe(fromDeploy);
  });

  // 与应用侧同一口径：env 里的纯空白 = 没设（回落默认），而不是拼成 "ghcr.io/   "。
  it("纯空白 MEDIA_TRACK_UPDATE_REPO 视作未设（两处脚本 + 应用侧同一口径）", () => {
    const blank = { MEDIA_TRACK_UPDATE_REPO: "   " };
    expect(probe(DEPLOY, '_UPDATE_REPO_RAW="', "IMAGE=", "IMAGE", blank)).toBe(
      "ghcr.io/xixjohan/mediary-scout:v2026.10.02",
    );
    expect(probe(RUN_UPDATE, '_UPDATE_REPO_RAW="', "IMAGE_BASE=", "UPDATE_REPO", blank)).toBe(
      "xixjohan/mediary-scout",
    );
    // 两个脚本都必须真的做了 trim（否则上面两条是「碰巧」过的）
    expect(DEPLOY).toContain("tr -d '[:space:]'");
    expect(RUN_UPDATE).toContain("tr -d '[:space:]'");
  });
});
