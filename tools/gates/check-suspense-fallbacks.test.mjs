import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { analyzeSuspenseFallbacks } from "./check-suspense-fallbacks.mjs";

describe("Suspense Fallbacks & Static Skeleton Gate Verification", () => {
  it("passes check-suspense-fallbacks.mjs on actual repository with 0 violations", () => {
    const scriptPath = join(process.cwd(), "tools/gates/check-suspense-fallbacks.mjs");
    const output = execSync(`node "${scriptPath}"`, { encoding: "utf8" });
    expect(output).toContain("所有页面 Suspense Fallback 均为纯静态骨架");
  });

  it("catches AppSidebar missing skeleton prop in a Shell component (Rule 1)", () => {
    const badCode = `
import { Suspense } from "react";
import { AppSidebar } from "../components/layout/app-sidebar";

export function CustomShell() {
  return (
    <div className="app-shell">
      <AppSidebar active="search" />
      <main />
    </div>
  );
}
`;
    const violations = analyzeSuspenseFallbacks("apps/web/app/custom/page.tsx", badCode);
    expect(violations.some((v) => v.rule === "AppSidebar-Skeleton-In-Shell")).toBe(true);
  });

  it("allows AppSidebar with skeleton prop in a Shell component", () => {
    const goodCode = `
import { Suspense } from "react";
import { AppSidebar } from "../components/layout/app-sidebar";

export function CustomShell() {
  return (
    <div className="app-shell">
      <AppSidebar active="search" skeleton />
      <main />
    </div>
  );
}
`;
    const violations = analyzeSuspenseFallbacks("apps/web/app/custom/page.tsx", goodCode);
    expect(violations.length).toBe(0);
  });

  it("catches async dynamic loader placed directly in Suspense fallback (Rule 2)", () => {
    const badCode = `
import { Suspense } from "react";
import { AccountIdentityLoader } from "../features/auth/components/account-identity-loader";

export default function TestPage() {
  return (
    <Suspense fallback={<div><AccountIdentityLoader /></div>}>
      <main />
    </Suspense>
  );
}
`;
    const violations = analyzeSuspenseFallbacks("apps/web/app/custom/page.tsx", badCode);
    expect(violations.some((v) => v.rule === "No-Async-Loader-In-Fallback")).toBe(true);
  });

  it("catches SearchResults without await connection() in page.tsx (Rule 3)", () => {
    const badCode = `
import { Suspense } from "react";

async function SearchResults({ query }: { query: string }) {
  const result = await fetchSomething(query);
  return <div>{result}</div>;
}
`;
    const violations = analyzeSuspenseFallbacks("apps/web/app/page.tsx", badCode);
    expect(violations.some((v) => v.rule === "Declare-Connection-For-Dynamic-Hole")).toBe(true);
  });
});
