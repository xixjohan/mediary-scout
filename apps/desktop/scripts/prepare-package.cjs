"use strict";
const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");
const sharedDir = path.join(repoRoot, "packages", "shared");
const targetDir = path.join(desktopDir, "node_modules", "@media-track", "shared");

fs.mkdirSync(targetDir, { recursive: true });

// Copy package.json
fs.copyFileSync(
  path.join(sharedDir, "package.json"),
  path.join(targetDir, "package.json")
);

// Copy dist directory
const distSrc = path.join(sharedDir, "dist");
const distDest = path.join(targetDir, "dist");
if (fs.existsSync(distSrc)) {
  fs.cpSync(distSrc, distDest, { recursive: true, force: true });
}

console.log("[prepare-package] Successfully prepared @media-track/shared in apps/desktop/node_modules/@media-track/shared");
