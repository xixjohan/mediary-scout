// @ts-check
import tseslint from "typescript-eslint";
import nextPlugin from "@next/eslint-plugin-next";
import localRules from "./tools/linter/eslint-local-rules.mjs";

/**
 * 架构门禁（任务单 S4.1，治理文档 §6）：
 *   L2 源码边界 —— no-restricted-imports 区域规则（ESLint 核心规则，无需插件）：
 *     · packages/shared 是基础层：严禁依赖 workflow / contracts / apps；
 *     · apps/* 互相隔离：web / desktop / host-worker 不得跨应用引用；
 *     · packages/workflow 是库：严禁反向依赖 apps/*。
 *   L3 实现约束 —— max-lines(600) + complexity(15)：存量违规由
 *     eslint-suppressions.json 基线接管（文档 §6.3 Baseline 机制），
 *     新增/修改的文件必须合规——这就是「严禁再出 3000 行文件」的硬阻断。
 */

/**
 * Focused, type-aware lint. We intentionally do NOT enable the full
 * recommendedTypeChecked preset (it would flag hundreds of pre-existing
 * stylistic issues and red the CI). Instead we enable the few rules that catch
 * REAL bugs in an async/worker-heavy codebase — chiefly unawaited promises that
 * fail silently. Production source only; tests excluded for now.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      ".omo/**",
      "**/*.js",
      "**/*.cjs",
      "**/*.mjs",
      "apps/web/next-env.d.ts",
      "scripts/**",
      "tools/**",
      "tests/**",
      "**/*.test.ts",
      "**/*.test.tsx",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    // Register the Next plugin so the existing `// eslint-disable-next-line
    // @next/next/no-img-element` comments resolve to a real rule. We do NOT
    // enable its rules here (next build runs them separately) — registering it
    // just stops ESLint erroring on "rule definition not found".
    plugins: { "@next/next": nextPlugin },
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      // Enabled so the existing intentional `// eslint-disable-next-line
      // @next/next/no-img-element` comments (TMDB-CDN <img> tags) are valid, and
      // any NEW undisabled <img> is caught here too (matches `next build`).
      "@next/next/no-img-element": "error",
    },
  },

  // ---- L2：源码边界（区域规则）----
  {
    // packages/shared：无业务属主的基础层，只能被依赖，不能依赖别人。
    files: ["packages/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@media-track/workflow", "@media-track/workflow/*"],
              message: "L2 违规：shared 是基础层，严禁依赖 @media-track/workflow（依赖方向只能反过来）",
            },
            {
              group: ["@media-track/contracts", "@media-track/contracts/*"],
              message: "L2 违规：shared 不应依赖 contracts——基础工具保持零框架零契约",
            },
            {
              group: ["**/apps/**", "apps/*"],
              message: "L2 违规：shared 是跨端基础层，严禁引用任何 apps/* 宿主代码",
            },
          ],
        },
      ],
    },
  },
  {
    // apps/* 宿主互相隔离（包名级）。注意：ESLint 的 no-restricted-imports 用
    // ignore(gitignore) 语义匹配，**无法匹配带 `..` 的相对引用**——文件级的
    // 跨宿主边界（含相对路径逃逸）由 dependency-cruiser 负责（见 L1，
    // .dependency-cruiser.cjs 的 no-cross-app-* 规则）。
    files: ["apps/web/**/*.ts", "apps/desktop/**/*.ts", "apps/host-worker/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@media-track/desktop", "@media-track/desktop/*"],
              message: "L2 违规：宿主互相隔离——不得引用 @media-track/desktop",
            },
            {
              group: ["@media-track/web", "@media-track/web/*"],
              message: "L2 违规：宿主互相隔离——不得引用 @media-track/web（host-worker 只经 HTTP poke 交互）",
            },
            {
              group: ["@media-track/host-worker", "@media-track/host-worker/*"],
              message: "L2 违规：宿主互相隔离——不得引用 @media-track/host-worker",
            },
          ],
        },
      ],
    },
  },
  {
    // packages/workflow 是业务库：严禁反向依赖任何 apps/*。
    files: ["packages/workflow/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@media-track/web", "@media-track/web/*", "@media-track/desktop", "@media-track/desktop/*", "@media-track/host-worker", "@media-track/host-worker/*"],
              message: "L2 违规：workflow 是被复用的业务库，严禁依赖 apps/* 宿主代码",
            },
          ],
        },
      ],
    },
  },

  // ---- S5.4：/api 路由登录认证门禁（白名单见 tools/eslint-local-rules.mjs）----
  {
    // apps/web/app/api 下除 health / auth 登录面 / worker-secret / updater-token /
    // owner-session 白名单与 agent 独立 token 之外的每个 route.ts，都必须调用
    // requireApiAccount 登录链；漏挂即 lint 红。与 vitest 的
    // route-auth-inventory.test.ts 同源白名单，两层兜底。
    // 显式列出顶层 route.ts：`**/` 在多数 glob 实现里匹配零层也行，但这里
    // 不赌实现——顶层 /api/route.ts 曾是两层门禁的共同盲区（ESLint glob 与
    // 规则正则都要求 api 下至少一层目录），补上才算真兜底。
    files: ["apps/web/app/api/**/route.ts", "apps/web/app/api/route.ts"],
    plugins: { local: localRules },
    rules: {
      "local/api-auth-required": "error",
    },
  },

  // ---- L3：实现约束（存量由 suppressions 基线接管）----
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "apps/web/next-env.d.ts"],
    rules: {
      "max-lines": ["error", { max: 600, skipBlankLines: true, skipComments: true }],
      complexity: ["error", 15],
    },
  },
);
