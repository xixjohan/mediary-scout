import { defineConfig } from "vitest/config";

export default defineConfig({
  // apps/web/tsconfig.json sets jsx: "preserve" for Next; Vite 8's oxc transform
  // would then leave JSX in place and fail import analysis on any .tsx a test
  // touches. Force the automatic runtime so server components can be
  // string-rendered in tests. (Vite 8 ignores the legacy `esbuild` key.)
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "workers/**/*.test.ts", "site/**/*.test.mjs", "updater/**/*.test.mjs", "tools/**/*.test.mjs"],
    // 构建产物不是测试源：`next build` 会把 route.ts（连同旁边的 .test.ts）
    // 拷进 .next/standalone，vitest 的 apps/** 通配会捡到这些陈旧副本——
    // 它们的相对 import 在 standalone 布局下解析不到 lib/，必红。
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/.turbo/**"],
    environment: "node",
    passWithNoTests: false,
  },
});
