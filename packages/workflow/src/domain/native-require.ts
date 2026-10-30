/**
 * A CommonJS `require` for native modules, obtained **without any static import of a
 * node: builtin**.
 *
 * ## Why this exists
 *
 * `@media-track/workflow` is re-exported by a barrel (`workflow-scope.js`) that client
 * components import from. Anything this package statically imports from `node:` therefore
 * becomes a dependency of *client* chunks too — and Turbopack refuses the entire
 * production build for those:
 *
 *   the chunking context (unknown) does not support external modules (request: node:module)
 *
 * That is a deploy blocker, not a warning, and it is invisible to `npm run gate`
 * (layout + deps + eslint, no type-check of apps/web, no web build).
 *
 * The invariant is older than this module: `sqlite-json-cache.ts` has carried a comment
 * about it since S4.3 ("静态 node:fs 会炸 Turbopack 客户端 chunk") and loads node:fs /
 * node:path through a lazy requireNative — but that same file still had
 * `import { createRequire } from "node:module"` on line 1, so the fix never actually took
 * effect for the bundler. `native-require.test.ts` now enforces the invariant by scanning
 * the source, so it cannot regress silently again.
 *
 * ## Why the id is assembled
 *
 * `process.getBuiltinModule("node:module")` is itself detected by Turbopack: the literal
 * string is enough to register node:module as an external request. Assembling the id from
 * parts leaves nothing for the bundler's static analysis to follow, while the runtime value
 * is identical. (Verified: with the literal the build fails; assembled, it passes.)
 */
import type NodeJS from "node:process";

/** Build a `require` rooted at `from` (pass `import.meta.url`). */
export function createNativeRequire(from: string): NodeJS.Require {
  const nodeModule = process.getBuiltinModule(["node", "module"].join(":")) as
    | typeof import("node:module")
    | undefined;
  if (nodeModule === undefined) {
    throw new Error(
      "process.getBuiltinModule('node:module') returned undefined; " +
        "this Node is too old (needs 22.3+) to load native modules without a static import.",
    );
  }
  return nodeModule.createRequire(from);
}
