import { nativePath as path } from "../domain/native-require.js";
import fs from "node:fs/promises";
import type { ExtensionEntity, ExtensionManifest } from "./extension-types.js";
import { extractZipSafely } from "./zip-extractor.js";
import { ExtensionMementoEditor } from "./memento-editor.js";

export class ExtensionManager {
  constructor(private readonly _baseDir: string) {}

  public getBaseDir(): string {
    return this._baseDir;
  }

  public async init(): Promise<void> {
    await fs.mkdir(this._baseDir, { recursive: true });
  }

  public async listExtensions(): Promise<ExtensionEntity[]> {
    await this.init();
    try {
      const dirs = await fs.readdir(this._baseDir, { withFileTypes: true });
      const entities: ExtensionEntity[] = [];

      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const rootDir = path.join(this._baseDir, d.name);
        const manifestPath = path.join(rootDir, "manifest.json");
        try {
          const raw = await fs.readFile(manifestPath, "utf8");
          const manifest = JSON.parse(raw) as ExtensionManifest;
          const stat = await fs.stat(manifestPath);
          entities.push({
            manifest,
            rootDir,
            createdAt: stat.birthtimeMs,
            updatedAt: stat.mtimeMs,
          });
        } catch {
          // ignore invalid folder
        }
      }
      return entities;
    } catch {
      return [];
    }
  }

  public async getExtension(id: string): Promise<ExtensionEntity | null> {
    const all = await this.listExtensions();
    return all.find((e) => e.manifest.id === id) || null;
  }

  public async importFromZip(zipFilePath: string): Promise<ExtensionEntity> {
    await this.init();
    const tempDir = path.join(this._baseDir, `.temp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    const manifest = await extractZipSafely(zipFilePath, tempDir);

    const targetDir = path.join(this._baseDir, manifest.id);
    // 若已存在，先清理旧版
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
    await fs.rename(tempDir, targetDir);

    return {
      manifest,
      rootDir: targetDir,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  public async createScaffolding(id: string, name: string): Promise<ExtensionEntity> {
    await this.init();
    const cleanId = id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    const targetDir = path.join(this._baseDir, cleanId);
    await fs.mkdir(targetDir, { recursive: true });

    const manifest: ExtensionManifest = {
      id: cleanId,
      name: name.trim(),
      version: "1.0.0",
      type: "search-provider",
      entry: "index.js",
      description: "由 Mediary Scout 助手创建的动态资源提供商扩展",
      enabled: true,
    };

    const starterCode = `/**
 * ${name} - 动态资源提供商
 */
module.exports = {
  async search({ keyword, config }) {
    console.log(\`正在检索关键词: \${keyword}\`);
    // 在此处编写具体的 HTTP 检索、HTML/API 解析逻辑
    return {
      candidates: [
        {
          title: \`[\${keyword}] 示例影视资源 4K Remux\`,
          type: "pan115",
          source: "${name}",
          payload: { shareUrl: "https://115.com/s/example" }
        }
      ]
    };
  }
};
`;

    await fs.writeFile(path.join(targetDir, "package.json"), JSON.stringify({ name: cleanId, type: "commonjs" }, null, 2), "utf8");
    await fs.writeFile(path.join(targetDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await fs.writeFile(path.join(targetDir, "index.js"), starterCode, "utf8");

    return {
      manifest,
      rootDir: targetDir,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  public async deleteExtension(id: string): Promise<boolean> {
    const ext = await this.getExtension(id);
    if (!ext) return false;
    await fs.rm(ext.rootDir, { recursive: true, force: true });
    return true;
  }

  public async setExtensionEnabled(id: string, enabled: boolean): Promise<boolean> {
    const ext = await this.getExtension(id);
    if (!ext) return false;
    ext.manifest.enabled = enabled;
    const manifestPath = path.join(ext.rootDir, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify(ext.manifest, null, 2), "utf8");
    return true;
  }
}
