/**
 * 宿主与扩展代码之间的无特权隔离中继 (Child Process Harness)
 */
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const entryFile = process.argv[2];

if (!entryFile) {
  process.send?.({ success: false, error: "未指定扩展入口文件路径" });
  process.exit(1);
}

let extensionModulePromise = null;
function getExtensionModule() {
  if (!extensionModulePromise) {
    extensionModulePromise = (async () => {
      const resolved = path.resolve(entryFile);
      try {
        return require(resolved);
      } catch (cjsErr) {
        try {
          return await import(pathToFileURL(resolved).href);
        } catch {
          throw cjsErr;
        }
      }
    })();
  }
  return extensionModulePromise;
}

process.on("message", async (msg) => {
  if (!msg || typeof msg !== "object") return;
  const { id, method, payload } = msg;

  try {
    const extensionModule = await getExtensionModule();
    const handler =
      (extensionModule && typeof extensionModule[method] === "function" && extensionModule[method]) ||
      (extensionModule && typeof extensionModule.default === "function" && extensionModule.default) ||
      (extensionModule && extensionModule.default && typeof extensionModule.default[method] === "function" && extensionModule.default[method]) ||
      (typeof extensionModule === "function" && extensionModule);

    if (!handler) {
      throw new Error(`扩展未导出方法 [${method}] 或默认函数`);
    }

    const result = await Promise.resolve(handler(payload));
    process.send?.({ id, success: true, data: result });
  } catch (err) {
    process.send?.({
      id,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
