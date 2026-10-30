import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Direct workspace source aliases: tests in apps/* and packages/* always run
  // against live TypeScript sources in packages/*/src without waiting for a
  // manual `npm run build:workflow` step or hitting stale dist/ artifacts.
  resolve: {
    alias: [
      {
        find: "@media-track/workflow/domain",
        replacement: resolve(rootDir, "packages/workflow/src/domain.ts"),
      },
      {
        find: "@media-track/workflow/scope",
        replacement: resolve(rootDir, "packages/workflow/src/workflow-scope.ts"),
      },
      {
        find: "@media-track/workflow/search-view",
        replacement: resolve(rootDir, "packages/workflow/src/search-view.ts"),
      },
      {
        find: "@media-track/workflow/user-requests",
        replacement: resolve(rootDir, "packages/workflow/src/user-requests.ts"),
      },
      {
        find: "@media-track/workflow",
        replacement: resolve(rootDir, "packages/workflow/src/index.ts"),
      },
      {
        find: "@media-track/shared/release-tag",
        replacement: resolve(rootDir, "packages/shared/src/release-tag.ts"),
      },
      {
        find: "@media-track/shared",
        replacement: resolve(rootDir, "packages/shared/src/index.ts"),
      },
      {
        find: "@media-track/contracts",
        replacement: resolve(rootDir, "packages/contracts/src/index.ts"),
      },
    ],
  },
  // apps/web/tsconfig.json sets jsx: "preserve" for Next; Vite 8's oxc transform
  // would then leave JSX in place and fail import analysis on any .tsx a test
  // touches. Force the automatic runtime so server components can be
  // string-rendered in tests. (Vite 8 ignores the legacy `esbuild` key.)
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "apps/**/*.test.mjs", "workers/**/*.test.ts", "site/**/*.test.mjs", "tools/**/*.test.mjs"],
    // 构建产物不是测试源：`next build` 会把 route.ts（连同旁边的 .test.ts）
    // 拷进 .next/standalone，vitest 的 apps/** 通配会捡到这些陈旧副本——
    // 它们的相对 import 在 standalone 布局下解析不到 lib/，必红。
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/.turbo/**"],
    environment: "node",
    passWithNoTests: false,
  },
});
