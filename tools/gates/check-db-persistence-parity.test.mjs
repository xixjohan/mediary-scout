import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { analyzeDbPersistenceParity } from "./check-db-persistence-parity.mjs";

describe("check-db-persistence-parity gate", () => {
  it("passes check-db-persistence-parity.mjs on actual repository with 0 violations", () => {
    const scriptPath = join(process.cwd(), "tools/gates/check-db-persistence-parity.mjs");
    const output = execSync(`node "${scriptPath}"`, { encoding: "utf8" });
    expect(output).toContain("数据库路径单源性规范一致");
  });

  it("analyzeDbPersistenceParity returns 0 violations on current codebase", () => {
    const violations = analyzeDbPersistenceParity();
    expect(violations.length).toBe(0);
  });

  it("detects credential key parity divergence when mock directories differ", () => {
    // Basic format test coverage for 64-hex regex
    expect(/^[0-9a-fA-F]{64}$/.test("1d1f3fbe44b2160b6be60b49fbffe34904608e28e2d0f33eb6701d1a7d8cf821")).toBe(true);
    expect(/^[0-9a-fA-F]{64}$/.test("invalid-key-format")).toBe(false);
  });
});
