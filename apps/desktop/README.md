# Mediary Scout — macOS desktop build

This package wraps the Next standalone server in an Electron shell and packages a
signed, notarized `.dmg`. The Electron main process (`src/main.ts`) spawns the
Next server as a Node child (`ELECTRON_RUN_AS_NODE`) and points a `BrowserWindow`
at it.

> **This build must be run on macOS** with Xcode command-line tools and an Apple
> Developer account. It cannot be produced on Linux/Windows (no code-signing, no
> `.dmg` target, native modules must match the target ABI).

## Layout that packaging relies on

`resolveServerEntry` (in `src/server-launch.ts`) resolves the packaged server to:

```
<process.resourcesPath>/app/apps/web/server.js
= Contents/Resources/app/apps/web/server.js
```

`electron-builder.yml`'s `extraResources` produces exactly that:

| from (relative to `apps/desktop`) | to (relative to `Contents/Resources`) | result |
| --- | --- | --- |
| `../web/.next/standalone` | `app` | `app/apps/web/server.js`, `app/node_modules/…`, `app/packages/workflow/dist/…` |
| `../web/.next/static` | `app/apps/web/.next/static` | static assets (not copied into standalone by Next) |
| `../web/public` | `app/apps/web/public` | public assets |

## Build steps (run from repo root unless noted)

### 1. Install (scripts enabled — downloads Electron + builds native modules)

```bash
npm install
```

### 2. Build the Next standalone server

```bash
npm run build:web
```

Produces `apps/web/.next/standalone/apps/web/server.js` (plus a traced
`node_modules`, including `better-sqlite3`).

### 3. better-sqlite3 的 Electron ABI —— 已自动化，无需手动

The server child runs under **Electron-as-Node**, so the bundled `better-sqlite3`
native binary must match **Electron's** ABI — not the build machine's system Node.
`after-pack.js`（electron-builder 的 `afterPack` 钩子）现在自动做三件事，**任何一步
失败都会让打包构建失败**，绝不会静默产出一个打不开数据库的桌面端：

1. 在打包产物里定位 Next standalone  traced 的那份 `better-sqlite3`；
2. 用 `prebuild-install -r electron -t <electronVersion>` 抓 Electron ABI 的预编译
   二进制换上（免本地编译工具链；实测抓取 `better-sqlite3-v12.11.1-electron-v130-*.tar.gz`）；
3. **强制验证**：① 二进制内容哈希必须真的变了（杀死 `@electron/rebuild`
   「报成功却没换二进制」的 silent no-op 前科）；② 让打包产物里的 Electron 以
   `ELECTRON_RUN_AS_NODE=1` 实际 `require()` 这份二进制并读回 ABI，必须等于 130。

改 Electron 大版本时，同步 `electron-builder.yml` 的 `electronVersion` 与
`after-pack.js` 里的 `ELECTRON_ABI`（33 → 130）。

想手动复核产物里的二进制（排障用）：

```bash
cat > /tmp/abi-check.js <<'EOF'
const Database = require(process.env.PWD + '/apps/web/.next/standalone/node_modules/better-sqlite3');
new Database(':memory:').exec('CREATE TABLE t(x)');
console.log('ABI_OK modules', process.versions.modules);   // must print 130 for Electron 33
EOF
ELECTRON_RUN_AS_NODE=1 <path-to-packaged-or-dist-Electron> /tmp/abi-check.js
```

### 4. Signing / notarization environment (NEVER commit these)

From your Apple Developer account, export before packaging:

```bash
# Code-signing identity (one of):
export CSC_LINK="/absolute/path/to/DeveloperIDApplication.p12"   # base64 or file path
export CSC_KEY_PASSWORD="<p12 password>"
# …or reference an identity already in the login keychain:
# export CSC_NAME="Your Name (TEAMID)"
# (electron-builder auto-selects "Developer ID Application:" — do NOT include that prefix)

# Notarization (electron-builder v25 `mac.notarize: true` reads these):
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # app-specific pw, NOT your Apple ID pw
export APPLE_TEAM_ID="A1B2C3D4E5"                          # 10-char team id
```

### 5. Package the signed, notarized dmg

```bash
npm run dist --workspace @media-track/desktop
```

Output lands in `apps/desktop/dist-app/`.

## Unsigned local smoke build (validate layout before signing)

To confirm the resource layout / server boot without a signing identity, disable
automatic identity discovery so electron-builder skips signing (and therefore
notarization):

```bash
export CSC_IDENTITY_AUTO_DISCOVERY=false
npm run dist --workspace @media-track/desktop
```

The resulting app is unsigned (Gatekeeper will warn), but you can open it to
verify the server child starts and the window loads. Do **not** ship this build.

## Notes

- `hardenedRuntime: true` + `build/entitlements.mac.plist` are required for
  notarization. The entitlements include
  `com.apple.security.cs.disable-library-validation` so the hardened-runtime
  child can load better-sqlite3's non-Apple-signed `.node`.
- Steps 2 and 3 must run **before** step 5 — packaging copies the standalone
  bundle as-is; it does not rebuild the bundled native module for you.
- `npmRebuild` is intentionally `false` in `electron-builder.yml`: in this
  hoisted npm-workspaces monorepo, electron-builder's "installing production
  dependencies" step prunes the ROOT `node_modules` dev deps — deleting
  electron-builder (and app-builder-bin) out from under the running build. The
  Electron main process never loads better-sqlite3 itself (only the server
  child does, from the standalone bundle), so nothing is lost by skipping it.
