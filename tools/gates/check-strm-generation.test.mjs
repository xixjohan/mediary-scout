import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("check-strm-generation gate CLI", () => {
  it("passes check-strm-generation gate without violations", () => {
    const gateScript = path.join(repoRoot, "tools/gates/check-strm-generation.mjs");
    const output = execSync(`node ${gateScript}`, {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(output).toContain("STRM 递归扫描与层级保持质量门禁");
    expect(output).toContain("门禁质检通过");
  });
});
