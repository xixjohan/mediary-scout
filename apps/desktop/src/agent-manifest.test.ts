import { describe, it, expect } from "vitest";
import {
  generateAgentToken,
  loadOrCreateAgentToken,
  buildAgentManifest,
  agentManifestPath,
  writeAgentManifest,
} from "./agent-manifest.js";

/** A deterministic randomBytes fake: fills `n` bytes with a fixed pattern. */
const fixedRandomBytes = (byte: number) => (n: number): Buffer => Buffer.alloc(n, byte);

describe("generateAgentToken", () => {
  it("returns 64 lowercase-hex chars (32 bytes)", () => {
    const token = generateAgentToken(fixedRandomBytes(0xab));
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).toBe("ab".repeat(32));
  });
});

describe("loadOrCreateAgentToken", () => {
  it("reuses an existing valid token (trimmed) without writing", () => {
    const existing = "0".repeat(64);
    let wrote = false;
    const token = loadOrCreateAgentToken({
      tokenFilePath: "/u/agent-token",
      readFile: () => `  ${existing}\n`, // whitespace must be trimmed away
      writeFile: () => { wrote = true; },
      randomBytes: fixedRandomBytes(0xff),
    });
    expect(token).toBe(existing);
    expect(wrote).toBe(false); // idempotent: no regenerate, no rewrite
  });

  it("regenerates + persists when the file is missing", () => {
    const writes: Array<{ path: string; content: string; mode: number }> = [];
    const token = loadOrCreateAgentToken({
      tokenFilePath: "/u/agent-token",
      readFile: () => null,
      writeFile: (path, content, mode) => writes.push({ path, content, mode }),
      randomBytes: fixedRandomBytes(0x01),
    });
    expect(token).toBe("01".repeat(32));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ path: "/u/agent-token", content: token, mode: 0o600 });
  });

  it("regenerates when the existing token is malformed (wrong length / non-hex)", () => {
    for (const bad of ["not-a-token", "ABCDEF", "z".repeat(64), "0".repeat(63), "0".repeat(65)]) {
      let regenerated = false;
      const token = loadOrCreateAgentToken({
        tokenFilePath: "/u/agent-token",
        readFile: () => bad,
        writeFile: () => { regenerated = true; },
        randomBytes: fixedRandomBytes(0x02),
      });
      expect(token).toBe("02".repeat(32));
      expect(regenerated).toBe(true);
    }
  });

  it("persists a regenerated token with owner-only 0600 mode", () => {
    let mode = -1;
    loadOrCreateAgentToken({
      tokenFilePath: "/u/agent-token",
      readFile: () => null,
      writeFile: (_p, _c, m) => { mode = m; },
      randomBytes: fixedRandomBytes(0x03),
    });
    expect(mode).toBe(0o600);
  });
});

describe("buildAgentManifest", () => {
  it("emits the loopback baseUrl / token / version shape with a trailing newline", () => {
    const content = buildAgentManifest({ port: 4123, token: "ab".repeat(32), version: "1.2.3" });
    expect(content.endsWith("\n")).toBe(true);
    expect(JSON.parse(content)).toEqual({
      baseUrl: "http://127.0.0.1:4123",
      token: "ab".repeat(32),
      version: "1.2.3",
    });
  });
});

describe("agentManifestPath", () => {
  it("joins to <homedir>/.mediary/agent.json", () => {
    expect(agentManifestPath("/Users/me")).toBe("/Users/me/.mediary/agent.json");
  });
});

describe("writeAgentManifest", () => {
  it("mkdirs the parent dir, then writes the file 0600", () => {
    const calls: string[] = [];
    let mkdirPath = "";
    let write: { path: string; content: string; mode: number } | null = null;
    writeAgentManifest({
      manifestPath: "/Users/me/.mediary/agent.json",
      content: "{}\n",
      mkdir: (p) => { calls.push("mkdir"); mkdirPath = p; },
      writeFile: (path, content, mode) => { calls.push("write"); write = { path, content, mode }; },
    });
    expect(mkdirPath).toBe("/Users/me/.mediary"); // parent dir ensured
    expect(write).toEqual({ path: "/Users/me/.mediary/agent.json", content: "{}\n", mode: 0o600 });
    expect(calls).toEqual(["mkdir", "write"]); // dir before file
  });
});
