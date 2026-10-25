import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENC_PREFIX,
  decryptSecret,
  encryptSecret,
  initCredentialCrypto,
  isEncrypted,
} from "./credential-crypto.js";

/**
 * 凭据信封加密（任务单 S1.5，P15：凭据全明文存储）：
 * AES-256-GCM，格式 `enc:v1:<base64(iv|tag|ct)>`；密钥来自 env
 * MEDIA_TRACK_CREDENTIAL_KEY，否则数据库同目录的 credential.key（0600，自动生成）。
 * 旧明文无前缀 → decryptSecret 原样透传（迁移兼容）。
 */
describe("credential-crypto", () => {
  const dirs: string[] = [];
  const tmpDir = () => {
    const d = mkdtempSync(join(tmpdir(), "cred-crypto-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    delete process.env.MEDIA_TRACK_CREDENTIAL_KEY;
    initCredentialCrypto({ ephemeral: true });
  });

  it("roundtrip：加密后能解回原文", () => {
    initCredentialCrypto({ ephemeral: true });
    const secret = "UID=103164004_A1_1; CID=99887766; SEID=deadbeef";
    const stored = encryptSecret(secret);
    expect(decryptSecret(stored)).toBe(secret);
  });

  it("密文带 enc:v1: 前缀且不含明文", () => {
    initCredentialCrypto({ ephemeral: true });
    const stored = encryptSecret("super-secret-cookie-value");
    expect(stored.startsWith(ENC_PREFIX)).toBe(true);
    expect(stored).not.toContain("super-secret-cookie-value");
    expect(isEncrypted(stored)).toBe(true);
    expect(isEncrypted("UID=plain; CID=1")).toBe(false);
  });

  it("同一明文两次加密结果不同（随机 IV），但都能解回", () => {
    initCredentialCrypto({ ephemeral: true });
    const a = encryptSecret("same");
    const b = encryptSecret("same");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same");
    expect(decryptSecret(b)).toBe("same");
  });

  it("旧明文（无前缀）原样透传——迁移期读写不炸", () => {
    initCredentialCrypto({ ephemeral: true });
    expect(decryptSecret('{"cookie":"UID=legacy"}')).toBe('{"cookie":"UID=legacy"}');
    expect(decryptSecret("")).toBe("");
  });

  it("unicode 与空串 roundtrip", () => {
    initCredentialCrypto({ ephemeral: true });
    expect(decryptSecret(encryptSecret(""))).toBe("");
    expect(decryptSecret(encryptSecret("中文字幕组☂️RARBG"))).toBe("中文字幕组☂️RARBG");
  });

  it("密钥文件：首次 init 生成 0600 的 32 字节密钥，再次 init 复用同一密钥", () => {
    const dir = tmpDir();
    const keyFile = join(dir, "credential.key");
    initCredentialCrypto({ keyFilePath: keyFile });
    const stored = encryptSecret("cookie-A");

    const mode = statSync(keyFile).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readFileSync(keyFile, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);

    // 重新 init（模拟进程重启）：必须复用盘上的密钥，否则历史数据全丢
    initCredentialCrypto({ keyFilePath: keyFile });
    expect(decryptSecret(stored)).toBe("cookie-A");
  });

  it("换一把密钥解不动旧密文（GCM 认证失败抛错）", () => {
    const dir = tmpDir();
    const keyA = join(dir, "a.key");
    const keyB = join(dir, "b.key");
    initCredentialCrypto({ keyFilePath: keyA });
    const stored = encryptSecret("cookie-A");
    initCredentialCrypto({ keyFilePath: keyB });
    expect(() => decryptSecret(stored)).toThrow();
  });

  it("env MEDIA_TRACK_CREDENTIAL_KEY（hex / base64 32 字节）优先于密钥文件", () => {
    const dir = tmpDir();
    const keyFile = join(dir, "credential.key");
    initCredentialCrypto({ keyFilePath: keyFile });
    const viaFile = encryptSecret("x");

    process.env.MEDIA_TRACK_CREDENTIAL_KEY = "11".repeat(32); // 64 hex = 32B
    initCredentialCrypto({ keyFilePath: keyFile });
    const viaEnv = encryptSecret("x");
    expect(viaEnv).not.toBe(viaFile); // 换了密钥 → 密文不同
    expect(decryptSecret(viaEnv)).toBe("x");
    expect(() => decryptSecret(viaFile)).toThrow(); // 文件密钥已解不动

    // base64 形式同样接受
    process.env.MEDIA_TRACK_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
    initCredentialCrypto({ keyFilePath: keyFile });
    expect(decryptSecret(encryptSecret("y"))).toBe("y");
  });

  it("env 是任意长度口令时用 scrypt 派生（仍可 roundtrip）", () => {
    process.env.MEDIA_TRACK_CREDENTIAL_KEY = "一个中文口令-abc";
    initCredentialCrypto({ ephemeral: true });
    expect(decryptSecret(encryptSecret("z"))).toBe("z");
  });

  it("密文被篡改 → 抛错（认证标签防篡改）", () => {
    initCredentialCrypto({ ephemeral: true });
    const stored = encryptSecret("tamper-me");
    const flipped = `${stored.slice(0, -4)}AAAA`;
    expect(() => decryptSecret(flipped)).toThrow();
  });

  it("密钥文件已存在但内容非法 → 明确报错而不是静默换钥", () => {
    const dir = tmpDir();
    const keyFile = join(dir, "credential.key");
    writeFileSync(keyFile, "not-a-key\n");
    expect(() => initCredentialCrypto({ keyFilePath: keyFile })).toThrow(/credential\.key/);
  });
});
