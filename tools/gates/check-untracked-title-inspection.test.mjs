import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("check-untracked-title-inspection gate", () => {
  it("passes all untracked title search snapshot persistence and isolation checks", () => {
    const gateScript = path.join(repoRoot, "tools/gates/check-untracked-title-inspection.mjs");
    const output = execSync(`node "${gateScript}"`, {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(output).toContain("未追踪影视作品搜索快照与探活质量门禁全部通过！");
  });
});
