const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

/**
 * Electron 33 = NODE_MODULE_VERSION 130。
 * 与 electron-builder.yml 的 electronVersion 保持同步（改大版本必须同步这里）。
 */
const ELECTRON_ABI = 130;

/**
 * 打包产物里那份 better-sqlite3 的目录：Next standalone Bundle 被
 * extraResources 映射到 <resources>/app，其内 traced 的拷贝是为**系统 Node**
 * 构建的；Electron-as-Node 的 server 子进程加载它必须换成 Electron ABI。
 */
function resolveBundledSqliteDir(appOutDir, platform, productName) {
  const resourcesDir =
    platform === "darwin"
      ? path.join(appOutDir, `${productName}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");
  return path.join(
    resourcesDir,
    "app",
    "apps",
    "web",
    ".next",
    "standalone",
    "node_modules",
    "better-sqlite3",
  );
}

function resolveNativeBinary(dir) {
  return path.join(dir, "build", "Release", "better_sqlite3.node");
}

function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * 把打包产物里的 better-sqlite3 换成 Electron ABI 的预编译二进制，并**强制验证**。
 *
 * 为什么在 afterPack 做（而不是 README 让人手动 npx）：
 *   - 打包机无论之前对 standalone 拷贝做过什么，最终产物都保证是对的；
 *   - 验证失败直接让构建失败——杀死 @electron/rebuild「报成功却没换二进制」
 *     的 silent no-op 失败模式（桌面端打包最脆的那根弦）。
 *
 * 依赖全部注入以便单测（不碰真实文件系统 / 不真起进程）。
 */
async function rebuildBundledSqliteForElectron(options) {
  const {
    dir,
    electronVersion,
    electronBin,
    prebuildInstallBin,
    exec,
    hashFile: hash,
    log,
    exists = existsSync,
  } = options;

  const nativeBinary = resolveNativeBinary(dir);
  if (!exists(nativeBinary)) {
    throw new Error(`better-sqlite3 native binary not found in bundle: ${nativeBinary}`);
  }

  // 1) 抓 Electron 预编译二进制（免本地工具链；prebuild-install 找不到对应
  //    预编译会以非零退出失败——比编译出一个错的二进制好）。
  const before = hash(nativeBinary);
  exec("node", [prebuildInstallBin, "-r", "electron", "-t", electronVersion], {
    cwd: dir,
    stdio: "inherit",
  });

  // 2) 杀死 silent no-op：二进制内容必须真的变了。
  const after = hash(nativeBinary);
  if (before === after) {
    throw new Error(
      `better-sqlite3 binary did not change after the Electron ABI swap in ${dir} — ` +
        "the packaged app would crash with ERR_DLOPEN_FAILED on launch. Refusing to ship.",
    );
  }

  // 3) 终验：让 Electron 自己以 Node 模式 require 这份二进制，并读回 ABI。
  //    require 失败（ABI 不匹配）= 非零退出 = execFileSync 抛错。
  const script = `require(${JSON.stringify(dir)}); console.log(process.versions.modules)`;
  const out = exec(electronBin, ["-e", script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const abi = Number(String(out).trim());
  if (!Number.isFinite(abi) || abi !== ELECTRON_ABI) {
    throw new Error(
      `bundled better-sqlite3 loaded under Electron reports ABI ${String(out).trim() || "?"}, ` +
        `expected ${ELECTRON_ABI} — refusing to ship a desktop app that cannot open its database.`,
    );
  }
  log(`[after-pack] better-sqlite3 swapped to Electron ABI ${abi} and verified by loading it`);
  return { hash: after };
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const productName = context.packager.appInfo.productFilename;
  const electronBinary =
    platform === "darwin"
      ? `${context.appOutDir}/${productName}.app/Contents/MacOS/${productName}`
      : `${context.appOutDir}/${productName}.exe`;

  await flipFuses(electronBinary, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });

  // 原生 ABI 正规化（任务单 S2.4）：替换 + 强制验证，失败即构建失败。
  const dir = resolveBundledSqliteDir(context.appOutDir, platform, productName);
  if (!existsSync(dir)) {
    // 没有 standalone 拷贝（不该发生）时大声失败，而不是静默出一个打不开库的桌面端。
    throw new Error(`bundled better-sqlite3 not found at ${dir} — the standalone bundle mapping changed?`);
  }
  const electronVersion = context.packager.electronVersion;
  await rebuildBundledSqliteForElectron({
    dir,
    electronVersion,
    electronBin: electronBinary,
    prebuildInstallBin: require.resolve("prebuild-install/bin.js"),
    exec: execFileSync,
    hashFile: hashFile,
    exists: existsSync,
    log: (message) => console.log(message),
  });
};

exports.ELECTRON_ABI = ELECTRON_ABI;
exports.resolveBundledSqliteDir = resolveBundledSqliteDir;
exports.rebuildBundledSqliteForElectron = rebuildBundledSqliteForElectron;
