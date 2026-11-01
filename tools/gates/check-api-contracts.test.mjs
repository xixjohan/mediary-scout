import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";

describe("API Contract Gate Verification", () => {
  it("passes check-api-contracts.mjs on actual repository with 0 violations", () => {
    const scriptPath = join(process.cwd(), "tools/gates/check-api-contracts.mjs");
    const output = execSync(`node "${scriptPath}"`, { encoding: "utf8" });
    expect(output).toContain("[Contract Gate] 门禁质检通过");
    expect(output).toContain("0 幽灵属性访问");
  });
});
