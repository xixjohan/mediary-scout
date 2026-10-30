import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";

describe("Style Gate Verification", () => {
  it("passes check-style-tokens.mjs against current stylesheets", () => {
    const scriptPath = join(process.cwd(), "tools/check-style-tokens.mjs");
    const output = execSync(`node ${scriptPath}`, { encoding: "utf8" });
    expect(output).toContain("[Style Gate] 样式门禁质检通过");
    expect(output).toContain("0 处未定义变量引用");
  });
});
