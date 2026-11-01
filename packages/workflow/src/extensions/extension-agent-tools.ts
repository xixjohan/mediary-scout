import { nativePath as path } from "../domain/native-require.js";
import type { ExtensionManager } from "./extension-manager.js";
import { ExtensionMementoEditor } from "./memento-editor.js";
import { ForkSandboxRunner } from "./fork-sandbox-runner.js";
import type { DynamicProviderSearchResult } from "./extension-types.js";

export function createExtensionAgentTools(manager: ExtensionManager) {
  return {
    extension_create: {
      name: "extension_create",
      description: "在系统中脚手架新建一个动态资源提供商扩展（包含 manifest.json 与 index.js）",
      execute: async ({ id, name }: { id: string; name: string }) => {
        const ext = await manager.createScaffolding(id, name);
        return { ok: true, id: ext.manifest.id, name: ext.manifest.name, rootDir: ext.rootDir };
      },
    },

    extension_read_code: {
      name: "extension_read_code",
      description: "读取指定扩展中的源代码文件内容",
      execute: async ({ id, file }: { id: string; file: string }) => {
        const ext = await manager.getExtension(id);
        if (!ext) throw new Error(`未找到扩展: ${id}`);
        const content = await ExtensionMementoEditor.readCode(ext.rootDir, file);
        return { ok: true, content };
      },
    },

    extension_edit_code: {
      name: "extension_edit_code",
      description: "在线修改或重写指定扩展的代码文件，自动生成备忘录版本快照",
      execute: async ({ id, file, content }: { id: string; file: string; content: string }) => {
        const ext = await manager.getExtension(id);
        if (!ext) throw new Error(`未找到扩展: ${id}`);
        const result = await ExtensionMementoEditor.saveCode(ext.rootDir, file, content);
        return { ok: true, snapshotId: result.snapshotId };
      },
    },

    extension_rollback_code: {
      name: "extension_rollback_code",
      description: "将指定扩展的代码文件回滚到先前的备份快照",
      execute: async ({ id, file, snapshotId }: { id: string; file: string; snapshotId: string }) => {
        const ext = await manager.getExtension(id);
        if (!ext) throw new Error(`未找到扩展: ${id}`);
        await ExtensionMementoEditor.rollbackSnapshot(ext.rootDir, file, snapshotId);
        return { ok: true, rolledBackTo: snapshotId };
      },
    },

    extension_debug_run: {
      name: "extension_debug_run",
      description: "在轻量硬隔离子进程沙箱中调试试运行扩展搜索，验证其解析与提取效果",
      execute: async ({ id, keyword }: { id: string; keyword: string }) => {
        const ext = await manager.getExtension(id);
        if (!ext) throw new Error(`未找到扩展: ${id}`);

        const entryPath = path.resolve(ext.rootDir, ext.manifest.entry);
        const result = await ForkSandboxRunner.executeMethod<DynamicProviderSearchResult>(
          entryPath,
          "search",
          { keyword },
          { timeoutMs: 8000 }
        );

        return {
          ok: result.success,
          durationMs: result.durationMs,
          candidates: result.data?.candidates || [],
          error: result.error,
        };
      },
    },
  };
}
