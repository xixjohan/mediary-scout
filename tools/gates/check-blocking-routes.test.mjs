import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { analyzeRouteSource, analyzeLayoutShellSource } from "./check-blocking-routes.mjs";

describe("Next.js Blocking Routes Gate Verification", () => {
  it("passes check-blocking-routes.mjs on actual repository with 0 violations", () => {
    const scriptPath = join(process.cwd(), "tools/gates/check-blocking-routes.mjs");
    const output = execSync(`node "${scriptPath}"`, { encoding: "utf8" });
    expect(output).toContain("[Blocking Routes Gate] 质检通过");
    expect(output).toContain("0 项规范违规 (0 violations)");
  });

  it("catches blocking route error when export default is async and directly awaits searchParams", () => {
    const badCode = `
import { Suspense } from "react";
import { PageLoginGuard } from "../../../lib/page-auth-guard";

export default async function BadPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  const { w } = await searchParams;
  return (
    <div>
      <Suspense fallback={null}><PageLoginGuard /></Suspense>
      <h1>Bad Page</h1>
    </div>
  );
}
`;
    const violations = analyzeRouteSource("apps/web/app/settings/bad/page.tsx", badCode);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    const asyncRule = violations.find((v) => v.rule === "anti-blocking-route-async-export");
    const awaitRule = violations.find((v) => v.rule === "anti-blocking-route-direct-await");
    expect(asyncRule).toBeDefined();
    expect(awaitRule).toBeDefined();
  });

  it("catches page with dynamic params but no Suspense boundary", () => {
    const badCode = `
import { PageLoginGuard } from "../../../lib/page-auth-guard";

export default function BadPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  return <div>No Suspense</div>;
}
`;
    const violations = analyzeRouteSource("apps/web/app/test/page.tsx", badCode);
    const suspenseRule = violations.find((v) => v.rule === "suspense-boundary-required");
    expect(suspenseRule).toBeDefined();
  });

  it("catches Suspense missing fallback attribute", () => {
    const badCode = `
import { Suspense } from "react";
import { PageLoginGuard } from "../../../lib/page-auth-guard";

export default function BadPage() {
  return (
    <>
      <Suspense fallback={null}><PageLoginGuard /></Suspense>
      <Suspense>
        <div>Content</div>
      </Suspense>
    </>
  );
}
`;
    const violations = analyzeRouteSource("apps/web/app/test/page.tsx", badCode);
    const fallbackRule = violations.find((v) => v.rule === "suspense-fallback-missing");
    expect(fallbackRule).toBeDefined();
  });

  it("catches protected page missing PageLoginGuard or mounting it outside Suspense", () => {
    const missingGuard = `
import { Suspense } from "react";

export default function UnprotectedPage() {
  return (
    <Suspense fallback={<div>Loading</div>}>
      <div>Content</div>
    </Suspense>
  );
}
`;
    const violations = analyzeRouteSource("apps/web/app/secret/page.tsx", missingGuard);
    const guardRule = violations.find((v) => v.rule === "page-login-guard-missing-or-unsuspended");
    expect(guardRule).toBeDefined();

    const unsuspendedGuard = `
import { Suspense } from "react";
import { PageLoginGuard } from "../../../lib/page-auth-guard";

export default function BadGuardPage() {
  return (
    <div>
      <PageLoginGuard />
      <Suspense fallback={<div>Loading</div>}>
        <div>Content</div>
      </Suspense>
    </div>
  );
}
`;
    const unsuspendedViolations = analyzeRouteSource("apps/web/app/secret2/page.tsx", unsuspendedGuard);
    expect(unsuspendedViolations.some((v) => v.rule === "page-login-guard-missing-or-unsuspended")).toBe(true);
  });

  it("permits public /login page without PageLoginGuard", () => {
    const loginCode = `
"use client";
export default function LoginPage() {
  return <div>Login Form</div>;
}
`;
    const violations = analyzeRouteSource("apps/web/app/login/page.tsx", loginCode);
    expect(violations.length).toBe(0);
  });

  it("catches useSearchParams call in layout shell components (Rule 5)", () => {
    const badLayoutCode = `
"use client";
import { useSearchParams } from "next/navigation";

export function BadSidebarItem() {
  const params = useSearchParams();
  return <div>Item: {params.get("w")}</div>;
}
`;
    const violations = analyzeLayoutShellSource("apps/web/components/layout/bad-item.tsx", badLayoutCode);
    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe("layout-shell-no-use-search-params");
  });
});
