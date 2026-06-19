import type { Metadata } from "next";
import "./globals.css";

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
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
