import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prevSqlitePath = process.env.MEDIA_TRACK_SQLITE_PATH;
const prevMultiUser = process.env.MEDIA_TRACK_MULTI_USER;

const LIVE_COOKIE = "UID=10086115; CID=cid_val; SEID=seid_val; KID=kid_val";
const INVALID_COOKIE = "foo=bar; baz=qux";

const boot = async () => {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  delete process.env.MEDIA_TRACK_MULTI_USER;
  vi.resetModules();
  return import("./workflow-runtime");
};

let rt: typeof import("./workflow-runtime");
beforeEach(async () => {
  rt = await boot();
});

afterEach(() => {
  delete process.env.MEDIA_TRACK_SQLITE_PATH;
  if (prevSqlitePath !== undefined) process.env.MEDIA_TRACK_SQLITE_PATH = prevSqlitePath;
  if (prevMultiUser !== undefined) process.env.MEDIA_TRACK_MULTI_USER = prevMultiUser;
  vi.resetModules();
});

describe("connectPan115Cookie", () => {
  it("rejects blank or invalid cookie missing UID", async () => {
    await expect(rt.connectPan115Cookie("")).rejects.toThrow(/Cookie 不能为空/);
    await expect(rt.connectPan115Cookie(INVALID_COOKIE)).rejects.toThrow(/未找到 UID/);
  });

  it("binds a valid 115 cookie and saves connected_storage", async () => {
    const { providerUid, userName } = await rt.connectPan115Cookie(`  ${LIVE_COOKIE}  `);
    expect(providerUid).toBe("10086115");
    expect(userName).toContain("115_");

    const repo = rt.getWorkflowRepository();
    const bound = await repo.findConnectedStorageByUid("pan115", "10086115");
    expect(bound).not.toBeNull();
    expect(bound?.provider).toBe("pan115");
    expect((bound?.payload as { cookie?: string })?.cookie).toBe(LIVE_COOKIE);
  });
});
