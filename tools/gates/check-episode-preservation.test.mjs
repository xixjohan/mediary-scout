import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("check-episode-preservation gate", () => {
  it("passes when all code adheres to episode preservation constraints", () => {
    const scriptPath = path.join(__dirname, "check-episode-preservation.mjs");
    const output = execSync(`node "${scriptPath}"`, { encoding: "utf8" });
    expect(output).toContain("[Episode Preservation Gate] 门禁质检通过");
  });
});
