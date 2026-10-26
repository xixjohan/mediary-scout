import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteWorkflowRepository } from "../src/sqlite.js";
import { API_KEY_SETTING_KEY, ENC_PREFIX } from "@media-track/shared";

/** S5.2：API key 落盘必须走 app_settings 的透明加密（与 llm_api_key 同等待遇）。 */
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "api-key-enc-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("SqliteWorkflowRepository 的 API key 落盘", () => {
  it("写进去的是密文，读出来是明文（可逆、且入库即加密）", async () => {
    const dir = tmp();
    const path = join(dir, "mediary.db");
    const repo = createSqliteWorkflowRepository({ path });
    await repo.setSetting(API_KEY_SETTING_KEY, "sk-super-secret-1234");
    // 明文读回
    expect(await repo.getSetting(API_KEY_SETTING_KEY)).toBe("sk-super-secret-1234");
    await repo.close?.();
    // 磁盘上是密文（enc:v1: 前缀，且不含明文片段）
    const raw = new Database(path, { readonly: true });
    const row = raw.prepare("SELECT value FROM app_settings WHERE key = ?").get(API_KEY_SETTING_KEY) as { value: string };
    expect(row.value.startsWith(ENC_PREFIX)).toBe(true);
    expect(row.value).not.toContain("sk-super-secret");
    raw.close();
  });

  it("未设置时读回 null", async () => {
    const dir = tmp();
    const repo = createSqliteWorkflowRepository({ path: join(dir, "mediary.db") });
    expect(await repo.getSetting(API_KEY_SETTING_KEY)).toBeNull();
    await repo.close?.();
  });
});
