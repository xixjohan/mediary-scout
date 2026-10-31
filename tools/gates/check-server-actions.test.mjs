import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";

describe("Server Actions Gate Verification", () => {
  it("passes check-server-actions.mjs with 0 violations", () => {
    const scriptPath = join(process.cwd(), "tools/gates/check-server-actions.mjs");
    const output = execSync(`node "${scriptPath}"`, { encoding: "utf8" });
    expect(output).toContain("[Server Actions Gate] 质检通过");
    expect(output).toContain("无非法 'use server' 导出或 Edge 运行时泄漏");
  });
});
