"use strict";
const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");
const sharedDir = path.join(repoRoot, "packages", "shared");
const targetDir = path.join(desktopDir, "node_modules", "@media-track", "shared");
const targetDist = path.join(targetDir, "dist");

fs.mkdirSync(targetDist, { recursive: true });

// Read the compiled release-tag.js from packages/shared/dist
const releaseTagJs = fs.readFileSync(path.join(sharedDir, "dist", "release-tag.js"), "utf8");

// Convert ESM to pure CommonJS so Electron's Node 20 runtime can require() it without ERR_REQUIRE_ESM
const cjsCode = `"use strict";\n` +
  releaseTagJs.replace(/^export\s+function\s+/m, "function ") +
  `\nmodule.exports = { parseReleaseTag };\n`;

fs.writeFileSync(path.join(targetDist, "release-tag.cjs"), cjsCode, "utf8");
fs.writeFileSync(path.join(targetDist, "release-tag.js"), cjsCode, "utf8");

// Copy d.ts
if (fs.existsSync(path.join(sharedDir, "dist", "release-tag.d.ts"))) {
  fs.copyFileSync(
    path.join(sharedDir, "dist", "release-tag.d.ts"),
    path.join(targetDist, "release-tag.d.ts")
  );
}

// Write CommonJS package.json
const pkgJson = {
  name: "@media-track/shared",
  version: "1.0.0",
  main: "./dist/release-tag.js",
  types: "./dist/release-tag.d.ts",
  exports: {
    ".": {
      require: "./dist/release-tag.js",
      default: "./dist/release-tag.js"
    },
    "./release-tag": {
      require: "./dist/release-tag.js",
      default: "./dist/release-tag.js"
    }
  }
};

fs.writeFileSync(
  path.join(targetDir, "package.json"),
  JSON.stringify(pkgJson, null, 2) + "\n",
  "utf8"
);

console.log("[prepare-package] Successfully prepared CommonJS @media-track/shared in desktop node_modules");
