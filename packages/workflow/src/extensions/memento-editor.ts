import { nativePath as path } from "../domain/native-require.js";
import fs from "node:fs/promises";
import { assertSafeZipPath } from "./zip-extractor.js";

export interface CodeSnapshotInfo {
  id: string; // filename of backup
  timestamp: number;
}

export class ExtensionMementoEditor {
  private static readonly MAX_SNAPSHOTS = 5;

  /**
   * 读取扩展代码文件
   */
  public static async readCode(extensionDir: string, relativePath: string): Promise<string> {
    const fullPath = assertSafeZipPath(extensionDir, relativePath);
    return fs.readFile(fullPath, "utf8");
  }

  /**
   * 保存代码文件，并自动备份前序版本（备忘录模式）
   */
  public static async saveCode(
    extensionDir: string,
    relativePath: string,
    newContent: string
  ): Promise<{ snapshotId: string | null }> {
    const fullPath = assertSafeZipPath(extensionDir, relativePath);
    const backupDir = path.join(extensionDir, ".backups");
    await fs.mkdir(backupDir, { recursive: true });

    let snapshotId: string | null = null;
    const cleanRelName = relativePath.replace(/[/\\:]/g, "_");

    // 检查原文件是否存在以创建备份快照
    try {
      const existing = await fs.readFile(fullPath, "utf8");
      const timestamp = Date.now();
      snapshotId = `${cleanRelName}.bak_${timestamp}`;
      const backupPath = path.join(backupDir, snapshotId);
      await fs.writeFile(backupPath, existing, "utf8");

      // 清理超过 5 个的历史快照
      await this.pruneSnapshots(backupDir, cleanRelName);
    } catch {
      // 文件原本不存在（新建文件），无需备份
    }

    // 写入新代码
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, newContent, "utf8");

    return { snapshotId };
  }

  /**
   * 列举指定文件的历史备份快照
   */
  public static async listSnapshots(
    extensionDir: string,
    relativePath: string
  ): Promise<CodeSnapshotInfo[]> {
    const backupDir = path.join(extensionDir, ".backups");
    const cleanRelName = relativePath.replace(/[/\\:]/g, "_");

    try {
      const entries = await fs.readdir(backupDir);
      const prefix = `${cleanRelName}.bak_`;
      const matched = entries
        .filter((name) => name.startsWith(prefix))
        .map((name) => {
          const tsStr = name.slice(prefix.length);
          const timestamp = Number(tsStr) || 0;
          return { id: name, timestamp };
        })
        .sort((a, b) => b.timestamp - a.timestamp);

      return matched;
    } catch {
      return [];
    }
  }

  /**
   * 回滚指定历史快照
   */
  public static async rollbackSnapshot(
    extensionDir: string,
    relativePath: string,
    snapshotId: string
  ): Promise<void> {
    const fullPath = assertSafeZipPath(extensionDir, relativePath);
    const backupPath = assertSafeZipPath(path.join(extensionDir, ".backups"), snapshotId);

    const snapshotContent = await fs.readFile(backupPath, "utf8");
    await fs.writeFile(fullPath, snapshotContent, "utf8");
  }

  private static async pruneSnapshots(backupDir: string, cleanRelName: string): Promise<void> {
    try {
      const prefix = `${cleanRelName}.bak_`;
      const entries = await fs.readdir(backupDir);
      const matched = entries
        .filter((name) => name.startsWith(prefix))
        .map((name) => {
          const tsStr = name.slice(prefix.length);
          return { name, ts: Number(tsStr) || 0 };
        })
        .sort((a, b) => b.ts - a.ts);

      if (matched.length > this.MAX_SNAPSHOTS) {
        const toDelete = matched.slice(this.MAX_SNAPSHOTS);
        for (const item of toDelete) {
          await fs.unlink(path.join(backupDir, item.name)).catch(() => {});
        }
      }
    } catch {
      // ignore
    }
  }
}
