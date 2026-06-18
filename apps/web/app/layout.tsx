import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import { WorkspaceSwitcherLoader } from "../components/workspace-switcher-loader";

export const metadata: Metadata = {
  title: "Media Track",
  description: "Background media acquisition workflow dashboard.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning: browser extensions (e.g. 沉浸式翻译) inject
    // attributes like data-immersive-translate-page-theme onto <html> before
    // React hydrates, which would otherwise flag a false hydration mismatch.
    // This suppresses ONLY this element's own attribute diff (one level) — real
    // mismatches in the tree below still surface.
    <html lang="zh-CN" suppressHydrationWarning>
      <body suppressHydrationWarning>
        {children}
        {/* Drive switcher: renders only at ≥2 drives. In Suspense so its DB read
            never blocks the static shell (cacheComponents-safe). */}
        <Suspense fallback={null}>
          <WorkspaceSwitcherLoader />
        </Suspense>
      </body>
    </html>
  );
}
