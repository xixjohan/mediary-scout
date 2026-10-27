/**
 * A CommonJS `require` for native modules, obtained **without any static import of
 * `node:module`**.
 *
 * Mirrors `packages/workflow/src/native-require.ts`. It has to be a copy rather than an
 * import because the dependency direction is shared ← workflow: shared cannot reach into
 * the workflow package. (The duplication is the point — see the invariant note below.)
 *
 * ## The invariant
 *
 * `@media-track/shared` is re-exported by a barrel that client-reachable modules import
 * from (workflow's sqlite.ts does, and workflow's own barrel is imported by several
 * apps/web client components). So a static `import { createRequire } from "node:module"`
 * anywhere in this package lands in **client** chunks, and Turbopack refuses the entire
 * production build:
 *
 *   the chunking context (unknown) does not support external modules (request: node:module)
 *
 * That is a deploy blocker, and `npm run gate` cannot see it: gate is layout + deps +
 * eslint, with no type-check of apps/web and no web build.
 *
 * The invariant was already written down twice in this repo before this file existed —
 * `credential-crypto.ts` and `sqlite-json-cache.ts` both carry the S4.3 comment about
 * static node:fs blowing up Turbopack client chunks, and both load node:fs through a lazy
 * `requireNative`. Both nevertheless kept the static `createRequire` import on line 1, so
 * the documented fix never actually took effect for the bundler. Nothing enforced it.
 * `native-require.test.ts` now scans the source, so it cannot regress silently again.
 *
 * ## Why the id is assembled
 *
 * Turbopack also registers an external request from the *literal string* in
 * `process.getBuiltinModule("node:module")`. Assembling the id from parts leaves nothing
 * for its static analysis to follow; the runtime value is identical.
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
