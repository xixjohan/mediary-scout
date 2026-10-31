import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";

describe("Facades Gate Verification", () => {
  it("passes check-facades.mjs with 0 violations", () => {
    const scriptPath = join(process.cwd(), "tools/gates/check-facades.mjs");
    const output = execSync(`node "${scriptPath}"`, { encoding: "utf8" });
    expect(output).toContain("[Facades Gate] 门面与核心契约检验通过");
    expect(output).toContain("0 处悬空引用");
  });
});
