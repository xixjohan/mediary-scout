/**
 * L1 项目/包依赖门禁（任务单 S4.1，治理文档 §6.2）。
 *
 * 与 ESLint 的分工：ESLint 的 no-restricted-imports 用 ignore(gitignore) 语义，
 * 无法匹配带 `..` 的相对引用；dependency-cruiser 解析磁盘真实路径，文件级
 * 边界（含相对路径逃逸）与循环依赖在这里守。
 */
const APPS = ["web", "desktop", "host-worker"];

/** 宿主互相隔离：apps/X 不得引用 apps/Y（X≠Y），含 "../../desktop/src/..." 这种
 *  相对逃逸——正是 ESLint 匹配不到、而真实会发生的形式。 */
const crossAppRules = APPS.flatMap((from) =>
  APPS.filter((to) => to !== from).map((to) => ({
    name: `no-cross-app-${from}-to-${to}`,
    comment: `L1：宿主互相隔离——apps/${from} 不得引用 apps/${to}`,
    severity: "error",
    from: { path: `^apps/${from}/` },
    to: { path: `^apps/${to}/` },
  })),
);

module.exports = {
  options: {
    // dist/.next 是构建产物，不参与依赖图（CI 里跑一次 build 就会有一堆假循环）。
    doNotFollow: { path: ["node_modules", "dist", "\\.next"] },
    exclude: "(/dist/|/\\.next/)",
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".node"],
    },
  },
  forbidden: [
    {
      name: "no-circular",
      comment: "L1：禁止循环依赖",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    ...crossAppRules,
    {
      name: "shared-is-base-layer",
      comment: "L1：shared 是无属主基础层——只能被依赖，不能依赖 workflow/contracts/apps",
      severity: "error",
      from: { path: "^packages/shared/" },
      to: { path: "^(packages/(workflow|contracts)|apps)/" },
    },
    {
      name: "workflow-not-depending-on-apps",
      comment: "L1：workflow 是被复用的业务库，严禁依赖 apps/* 宿主",
      severity: "error",
      from: { path: "^packages/workflow/" },
      to: { path: "^apps/" },
    },
    {
      name: "contracts-stay-neutral",
      comment: "L1：contracts 是中立契约层，严禁依赖包内任何其他模块",
      severity: "error",
      from: { path: "^packages/contracts/" },
      // contracts 包内互相引用允许；指向包外的一切才违规。
      to: { path: "^(packages/(?!contracts)|apps|workers)/" },
    },
  ],
};
