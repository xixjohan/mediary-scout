import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 刷新权归属门禁（静态）。
 *
 * 115 的 refresh_token 是旋转型一次性凭据：两个实例共用同一账号时，
 * 任何一方刷新都会让另一方手里的副本失效（40140137，需人工重新授权）。
 * 因此约定「只有生产实例是刷新写者」，开发实例必须显式放弃刷新权。
 *
 * 这里直接读部署脚本，确保这条约定不会在后续改动中被悄悄删掉。
 */
const DEPLOY_SCRIPT = readFileSync(
  fileURLToPath(new URL("../../../scripts/deploy-remote.ps1", import.meta.url)),
  "utf8",
);

function runCommandLine(varName: string): string {
  const line = DEPLOY_SCRIPT.split(/\r?\n/).find((candidate) => candidate.includes(`$${varName} = "docker`));
  if (!line) throw new Error(`未找到 ${varName} 的 docker run 命令`);
  return line;
}

describe("115 OAuth 刷新权归属", () => {
  it("开发实例必须声明 PAN115_OAUTH_REFRESH_DISABLED=1", () => {
    expect(runCommandLine("devRunCmd")).toContain("PAN115_OAUTH_REFRESH_DISABLED=1");
  });

  it("生产实例必须是唯一刷新写者（不得禁用刷新）", () => {
    expect(runCommandLine("prodRunCmd")).not.toContain("PAN115_OAUTH_REFRESH_DISABLED");
  });
});
