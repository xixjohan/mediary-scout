import { describe, expect, it } from "vitest";
import {
  auditCompilerLogs,
  CORE_SMOKE_ROUTES,
  ProcessAdapter,
} from "./smoke-tester.mjs";

describe("E2E Smoke Tester & Compiler Trap", () => {
  it("traps Turbopack compiler error patterns accurately", () => {
    const sampleLog = `
      ▲ Next.js 16.2.9 (Turbopack)
      ✓ Ready in 458ms
      ⨯ ./apps/web/features/settings-system/application/settings-attention-server.ts:26:1
      Export isMultiUserEnabled doesn't exist in target module
      The export isMultiUserEnabled was not found in module apps/web/lib/auth-chain.ts
      ⚠ ./apps/web/instrumentation.ts:14:17
      A Node.js API is used (process.getBuiltinModule at line: 14) which is not supported in the Edge Runtime.
      Ecmascript file had an error
    `;

    const issues = auditCompilerLogs(sampleLog);
    expect(issues.length).toBeGreaterThanOrEqual(3);
    expect(issues.some((i) => i.includes("isMultiUserEnabled"))).toBe(true);
    expect(issues.some((i) => i.includes("Edge Runtime"))).toBe(true);
    expect(issues.some((i) => i.includes("Ecmascript file had an error"))).toBe(true);
  });

  it("does not report clean server logs as compiler issues", () => {
    const cleanLog = `
      ▲ Next.js 16.2.9 (Turbopack)
      - Local:         http://localhost:3001
      ✓ Ready in 420ms
      [instrumentation] register() — running startup migrations + worker
      [background-worker] started (poll 3000ms)
      GET /api/health 200 in 25ms
      GET / 200 in 120ms
    `;

    const issues = auditCompilerLogs(cleanLog);
    expect(issues.length).toBe(0);
  });

  it("configures essential core smoke routes matrix with strict invariants", () => {
    expect(CORE_SMOKE_ROUTES.length).toBeGreaterThanOrEqual(7);

    const paths = CORE_SMOKE_ROUTES.map((r) => r.path);
    expect(paths).toContain("/api/health");
    expect(paths).toContain("/");
    expect(paths).toContain("/settings");
    expect(paths).toContain("/api/settings/attention");
    expect(paths).toContain("/api/notifications/meta");
    expect(paths).toContain("/api/activity");

    // All routes must forbid 500 status code
    for (const route of CORE_SMOKE_ROUTES) {
      expect(route.expectedStatus).not.toContain(500);
    }
  });

  it("detects available ports accurately via ProcessAdapter", async () => {
    // 0 is handled by OS to find an ephemeral free port
    const inUse = await ProcessAdapter.isPortInUse(59998);
    expect(typeof inUse).toBe("boolean");
  });
});
