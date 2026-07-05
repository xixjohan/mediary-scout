/**
 * Pure functions for the desktop agent token + discovery manifest (spec §认证与发现).
 *
 * The Electron main process (main.ts) owns the real fs / crypto; every side effect
 * here is INJECTED so the logic is unit-testable with fakes. main.ts:
 *   - loads/creates the persistent token (userData) and injects it as
 *     MEDIA_TRACK_AGENT_TOKEN into the server child,
 *   - after a healthy boot, writes ~/.mediary/agent.json (0600) for agents to discover.
 */

/** A 64-char lowercase-hex token (32 bytes). This is the ONLY accepted shape on disk. */
const TOKEN_RE = /^[0-9a-f]{64}$/;

/** Generate a fresh 32-byte token as lowercase hex. `randomBytes` is injected (node crypto). */
export function generateAgentToken(randomBytes: (n: number) => Buffer): string {
  return randomBytes(32).toString("hex");
}

/**
 * Return the persisted agent token, creating + persisting one on first run.
 *
 * An existing file is reused only when it holds a valid token (trimmed, matches
 * /^[0-9a-f]{64}$/); a missing/empty/corrupt file is regenerated and rewritten so a
 * once-bad token can't wedge the app forever. The file is written 0o600 (owner-only) —
 * it is a bearer credential.
 */
export function loadOrCreateAgentToken(input: {
  tokenFilePath: string;
  readFile: (p: string) => string | null;
  writeFile: (p: string, content: string, mode: number) => void;
  randomBytes: (n: number) => Buffer;
}): string {
  const existing = input.readFile(input.tokenFilePath);
  if (existing !== null) {
    const trimmed = existing.trim();
    if (TOKEN_RE.test(trimmed)) return trimmed;
  }
  const token = generateAgentToken(input.randomBytes);
  input.writeFile(input.tokenFilePath, token, 0o600);
  return token;
}

/**
 * Build the agent.json discovery payload (spec §认证与发现): a loopback baseUrl, the
 * bearer token, and the app version. Returns a pretty-free JSON string with a trailing
 * newline (POSIX-friendly for `cat`).
 */
export function buildAgentManifest(input: { port: number; token: string; version: string }): string {
  const manifest = {
    baseUrl: `http://127.0.0.1:${input.port}`,
    token: input.token,
    version: input.version,
  };
  return `${JSON.stringify(manifest)}\n`;
}

/** The discovery-file location: `<homedir>/.mediary/agent.json`. */
export function agentManifestPath(homedir: string): string {
  return `${homedir}/.mediary/agent.json`;
}

/**
 * Persist the manifest at `manifestPath`, ensuring its parent dir exists first, and
 * writing 0o600 (the file embeds the bearer token). Both fs primitives are injected.
 */
export function writeAgentManifest(input: {
  manifestPath: string;
  content: string;
  mkdir: (p: string) => void;
  writeFile: (p: string, content: string, mode: number) => void;
}): void {
  const slash = input.manifestPath.lastIndexOf("/");
  const parent = slash > 0 ? input.manifestPath.slice(0, slash) : input.manifestPath;
  input.mkdir(parent);
  input.writeFile(input.manifestPath, input.content, 0o600);
}
