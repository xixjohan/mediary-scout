type Env = Record<string, string | undefined>;

/** Thrown by side-effectful entry points when the instance runs as a public,
 *  read-only demo. The deterministic server boundary — never trust the UI alone. */
export class DemoReadOnlyError extends Error {
  constructor() {
    super("演示站为只读：此操作在 demo 模式下不可用。请自部署后使用。");
    this.name = "DemoReadOnlyError";
  }
}

export function isDemoModeFromEnv(env: Env): boolean {
  return env.MEDIA_TRACK_DEMO_MODE === "1";
}

export function assertNotDemoFromEnv(env: Env): void {
  if (isDemoModeFromEnv(env)) {
    throw new DemoReadOnlyError();
  }
}

/** Convenience wrappers reading process.env (server only). */
export function isDemoMode(): boolean {
  return isDemoModeFromEnv(process.env);
}

export function assertNotDemo(): void {
  assertNotDemoFromEnv(process.env);
}
