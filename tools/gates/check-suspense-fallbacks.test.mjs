import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  analyzeSuspenseFallbacks,
  analyzeProxyMatcher,
  analyzePageAuthGuard,
} from "./check-suspense-fallbacks.mjs";

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

  it("catches async dynamic hole component without await connection() inside Suspense (Rule 4)", () => {
    const badCode = `
import { Suspense } from "react";

async function CustomSurface() {
  const data = await getRegisteredDriveCount();
  return <div>{data}</div>;
}

export default function CustomPage() {
  return (
    <Suspense fallback={<div />}>
      <CustomSurface />
    </Suspense>
  );
}
`;
    const violations = analyzeSuspenseFallbacks("apps/web/app/custom/page.tsx", badCode);
    expect(violations.some((v) => v.rule === "Dynamic-Hole-Connection-Required")).toBe(true);
  });

  it("passes when async dynamic hole component declares await connection() inside Suspense", () => {
    const goodCode = `
import { Suspense } from "react";
import { connection } from "next/server";

async function CustomSurface() {
  await connection();
  const data = await getRegisteredDriveCount();
  return <div>{data}</div>;
}

export default function CustomPage() {
  return (
    <Suspense fallback={<div />}>
      <CustomSurface />
    </Suspense>
  );
}
`;
    const violations = analyzeSuspenseFallbacks("apps/web/app/custom/page.tsx", goodCode);
    expect(violations.length).toBe(0);
  });

  it("catches redirect() call inside component mounted under Suspense (Rule 5)", () => {
    const badCode = `
import { Suspense } from "react";
import { redirect } from "next/navigation";

function BadComponent() {
  redirect("/login");
  return null;
}

export default function CustomPage() {
  return (
    <Suspense fallback={<div />}>
      <BadComponent />
    </Suspense>
  );
}
`;
    const violations = analyzeSuspenseFallbacks("apps/web/app/custom/page.tsx", badCode);
    expect(violations.some((v) => v.rule === "No-Suspense-Child-Redirect")).toBe(true);
  });

  it("catches missing icon.svg in proxy matcher (Rule 6)", () => {
    const badProxyCode = `
export const config = {
  matcher: [
    "/((?!api/auth|login|_next/static|_next/image|favicon.ico|.*\\\\.(?:ico|png|svg|jpg)$).*)",
  ],
};
`;
    const violations = analyzeProxyMatcher("apps/web/proxy.ts", badProxyCode);
    expect(violations.some((v) => v.rule === "Proxy-Matcher-Static-Assets-Excluded")).toBe(true);
  });

  it("passes proxy matcher when static assets and icon.svg are excluded", () => {
    const goodProxyCode = `
export const config = {
  matcher: [
    "/((?!api/auth|login|_next/static|_next/image|favicon.ico|icon.svg|apple-icon|manifest.webmanifest|robots.txt|sitemap.xml|.*\\\\.(?:ico|png|svg|jpg|jpeg|gif|webp|woff2?)$).*)",
  ],
};
`;
    const violations = analyzeProxyMatcher("apps/web/proxy.ts", goodProxyCode);
    expect(violations.length).toBe(0);
  });

  it("catches PageLoginGuard calling redirect() directly (Rule 7)", () => {
    const badGuardCode = `
import { redirect } from "next/navigation";

export async function PageLoginGuard() {
  const needed = true;
  if (needed) {
    redirect("/login");
  }
  return null;
}
`;
    const violations = analyzePageAuthGuard("apps/web/platform/next-context/page-auth-guard.ts", badGuardCode);
    expect(violations.some((v) => v.rule === "No-Suspense-Redirect-In-Guard")).toBe(true);
  });

  it("passes PageLoginGuard when using PageLoginRedirect", () => {
    const goodGuardCode = `
import { createElement, Fragment } from "react";

export function PageLoginRedirect() {
  return createElement(Fragment, null);
}

export async function PageLoginGuard() {
  const needed = true;
  if (needed) {
    return PageLoginRedirect();
  }
  return null;
}
`;
    const violations = analyzePageAuthGuard("apps/web/platform/next-context/page-auth-guard.ts", goodGuardCode);
    expect(violations.length).toBe(0);
  });
});
