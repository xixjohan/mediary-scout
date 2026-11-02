import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { analyzeHydrationSafety } from "./check-hydration-safety.mjs";

describe("Hydration Safety & Shell Integrity Gate Verification", () => {
  it("passes check-hydration-safety.mjs on actual repository with 0 violations", () => {
    const scriptPath = join(process.cwd(), "tools/gates/check-hydration-safety.mjs");
    const output = execSync(`node "${scriptPath}"`, { encoding: "utf8" });
    expect(output).toContain("[Hydration Safety Gate] 质检通过");
    expect(output).toContain("0 项水合安全违规 (0 violations)");
  });

  it("catches useSearchParams call in layout shell components (Rule 1)", () => {
    const badCode = `
"use client";
import { useSearchParams } from "next/navigation";

export function BadSidebarNav() {
  const params = useSearchParams();
  return <nav>Current: {params.get("tab")}</nav>;
}
`;
    const violations = analyzeHydrationSafety("apps/web/components/layout/bad-sidebar.tsx", badCode);
    expect(violations.some((v) => v.rule === "shell-no-direct-search-params")).toBe(true);
  });

  it("catches ad-hoc inline ternary checking default account in auth components (Rule 2)", () => {
    const badCode = `
"use client";
export function AccountBadge({ username }: { username: string }) {
  const display = username === "default" ? "管理员" : username;
  return <div>{display}</div>;
}
`;
    const violations = analyzeHydrationSafety("apps/web/features/auth/components/account-identity.tsx", badCode);
    expect(violations.some((v) => v.rule === "canonical-auth-display-formatter")).toBe(true);
  });

  it("catches synchronous render-time access to window.localStorage (Rule 3)", () => {
    const badCode = `
"use client";
export function DirectStorageCard() {
  const cachedTheme = localStorage.getItem("theme");
  return <div className={cachedTheme || "dark"}>Theme</div>;
}
`;
    const violations = analyzeHydrationSafety("apps/web/features/settings/direct-card.tsx", badCode);
    expect(violations.some((v) => v.rule === "no-render-time-browser-globals")).toBe(true);
  });

  it("allows window access inside useEffect, event handler, or typeof window guard", () => {
    const goodCode = `
"use client";
import { useEffect, useState } from "react";

export function SafeClientComponent() {
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const handleClick = () => {
    window.location.href = "/settings";
  };

  const directOrigin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";

  return (
    <button onClick={handleClick}>
      Origin: {origin || directOrigin}
    </button>
  );
}
`;
    const violations = analyzeHydrationSafety("apps/web/features/settings/safe-component.tsx", goodCode);
    expect(violations.length).toBe(0);
  });

  it("catches *Loader component mounted in layout outside of Suspense (Rule 4)", () => {
    const badCode = `
import { AccountIdentityLoader } from "./account-identity-loader";

export function BadLayout() {
  return (
    <aside>
      <AccountIdentityLoader />
    </aside>
  );
}
`;
    const violations = analyzeHydrationSafety("apps/web/components/layout/bad-layout.tsx", badCode);
    expect(violations.some((v) => v.rule === "async-loader-suspense-enclosed")).toBe(true);
  });

  it("catches unauthorized suppressHydrationWarning on arbitrary business components (Rule 5)", () => {
    const badCode = `
"use client";
export function SneakyButton() {
  return <button suppressHydrationWarning>Click</button>;
}
`;
    const violations = analyzeHydrationSafety("apps/web/features/dashboard/sneaky-button.tsx", badCode);
    expect(violations.some((v) => v.rule === "suppress-hydration-warning-allowlist")).toBe(true);
  });
});
