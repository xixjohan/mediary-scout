import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import {
  DEFAULT_UPDATE_REPO,
  fetchCommitRelation,
  fetchLatestDesktopRelease,
  fetchReleaseFeed,
  invalidateReleaseFeedCache,
  updateRepoSlug,
} from "./release-feed-server";

function fakeFetch(routes: Record<string, { status: number; body: string }>) {
  return vi.fn(async (url: string) => {
    const hit = routes[url];
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(hit.body, { status: hit.status });
  }) as unknown as typeof fetch;
}

const TAGS = "https://api.github.com/repos/xixjohan/mediary-scout/git/matching-refs/tags/v";
const ref = (tag: string, sha: string, type = "commit") => ({ ref: `refs/tags/${tag}`, object: { sha, type } });
const notes = (tag: string) =>
  `https://api.github.com/repos/xixjohan/mediary-scout/contents/release-notes/${tag}.md?ref=${tag}`;
const compare = (base: string, head: string) =>
  `https://api.github.com/repos/xixjohan/mediary-scout/compare/${base}...${head}`;

describe("fetchReleaseFeed", () => {
  beforeEach(() => invalidateReleaseFeedCache());

  it("keeps only valid release tags, newest first, with their notes", async () => {
    const fetchImpl = fakeFetch({
      [TAGS]: {
        status: 200,
        body: JSON.stringify([
          ref("v1.4.1", "a".repeat(40)),
          ref("v2099.12.31", "d".repeat(40)),
          // Outside 2000–2099: not a release tag.
          ref("v3000.01.01", "e".repeat(40)),
          ref("v2026.09.28", "b".repeat(40)),
          ref("v2026.10.02", "c".repeat(40)),
        ]),
      },
      [notes("v2026.10.02")]: { status: 200, body: "- 新增 一键更新" },
      [notes("v2026.09.28")]: { status: 404, body: "" },
    });
    const feed = await fetchReleaseFeed(fetchImpl);
    expect(feed.map((r) => r.tag)).toEqual(["v2099.12.31", "v2026.10.02", "v2026.09.28"]);
    expect(feed[1]).toMatchObject({ commit: "c".repeat(40), notes: [{ kind: "add", text: "一键更新" }] });
    expect(feed[2]!.notes).toEqual([]);
  });

  it("keeps every release, not just a first page, and fetches notes for the newest 10 only", async () => {
    const tags = Array.from({ length: 45 }, (_, index) => {
      const day = new Date(Date.UTC(2026, 9, 1) + index * 86_400_000).toISOString().slice(0, 10);
      return ref(`v${day.replaceAll("-", ".")}`, index.toString(16).padStart(40, "0"));
    });
    const fetchImpl = fakeFetch({ [TAGS]: { status: 200, body: JSON.stringify(tags) } });
    const feed = await fetchReleaseFeed(fetchImpl);
    expect(feed).toHaveLength(45);
    expect(feed.at(-1)?.tag).toBe("v2026.10.01");
    const noteCalls = vi.mocked(fetchImpl).mock.calls.filter(([url]) => String(url).includes("/contents/"));
    expect(noteCalls).toHaveLength(10);
  });

  it("skips annotated tags (their sha is a tag object, not a commit)", async () => {
    const fetchImpl = fakeFetch({
      [TAGS]: { status: 200, body: JSON.stringify([ref("v2026.10.02", "c".repeat(40), "tag"), ref("v2026.09.28", "b".repeat(40))]) },
    });
    expect((await fetchReleaseFeed(fetchImpl)).map((r) => r.tag)).toEqual(["v2026.09.28"]);
  });

  it("callers that arrive while a cold fetch is running share it (one burst of requests, not one per caller)", async () => {
    const fetchImpl = fakeFetch({
      [TAGS]: { status: 200, body: JSON.stringify([ref("v2026.10.02", "c".repeat(40))]) },
      [notes("v2026.10.02")]: { status: 200, body: "- 新增 一键更新" },
    });
    const [first, second, third] = await Promise.all([
      fetchReleaseFeed(fetchImpl),
      fetchReleaseFeed(fetchImpl),
      fetchReleaseFeed(fetchImpl),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // tags + one notes file
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("a fetch that started before 「检查更新」 does not refill the cache after it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stale = vi.fn(async (url: string) => {
      await gate;
      return url === TAGS
        ? new Response(JSON.stringify([ref("v2026.10.01", "b".repeat(40))]), { status: 200 })
        : new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const pending = fetchReleaseFeed(stale);
    invalidateReleaseFeedCache();
    const fresh = fakeFetch({ [TAGS]: { status: 200, body: JSON.stringify([ref("v2026.10.02", "c".repeat(40))]) } });
    expect((await fetchReleaseFeed(fresh))[0]?.tag).toBe("v2026.10.02");
    release();
    await pending;
    expect((await fetchReleaseFeed(fresh))[0]?.tag).toBe("v2026.10.02");
  });

  it("returns [] when GitHub is unreachable, and caches the failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchReleaseFeed(fetchImpl)).toEqual([]);
    expect(await fetchReleaseFeed(fetchImpl)).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("fetchCommitRelation", () => {
  beforeEach(() => invalidateReleaseFeedCache());

  it("returns where head stands relative to base", async () => {
    const base = "b".repeat(40);
    const head = "d".repeat(40);
    const fetchImpl = fakeFetch({ [compare(base, head)]: { status: 200, body: JSON.stringify({ status: "ahead" }) } });
    expect(await fetchCommitRelation(base, head, fetchImpl)).toBe("ahead");
  });

  it("returns null on failure or an unknown status", async () => {
    const base = "b".repeat(40);
    const head = "d".repeat(40);
    expect(await fetchCommitRelation(base, head, fakeFetch({}))).toBeNull();
    const odd = fakeFetch({ [compare(base, head)]: { status: 200, body: JSON.stringify({ status: "weird" }) } });
    invalidateReleaseFeedCache();
    expect(await fetchCommitRelation(base, head, odd)).toBeNull();
  });

  it("callers that arrive while the comparison is running share it", async () => {
    const base = "b".repeat(40);
    const head = "d".repeat(40);
    const fetchImpl = fakeFetch({ [compare(base, head)]: { status: 200, body: JSON.stringify({ status: "behind" }) } });
    const both = await Promise.all([fetchCommitRelation(base, head, fetchImpl), fetchCommitRelation(base, head, fetchImpl)]);
    expect(both).toEqual(["behind", "behind"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a comparison that started before 「检查更新」 does not overwrite the fresh answer", async () => {
    const base = "b".repeat(40);
    const head = "d".repeat(40);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The old request fails (a cached null would hide the update for five minutes).
    const stale = vi.fn(async () => {
      await gate;
      return new Response("", { status: 502 });
    }) as unknown as typeof fetch;
    const pending = fetchCommitRelation(base, head, stale);
    invalidateReleaseFeedCache();
    const fresh = fakeFetch({ [compare(base, head)]: { status: 200, body: JSON.stringify({ status: "behind" }) } });
    expect(await fetchCommitRelation(base, head, fresh)).toBe("behind");
    release();
    await pending;
    expect(await fetchCommitRelation(base, head, fakeFetch({}))).toBe("behind");
  });
});

const LATEST = "https://api.github.com/repos/xixjohan/mediary-scout/releases/latest";
const asset = (name: string) => ({
  name,
  browser_download_url: `https://github.com/xixjohan/mediary-scout/releases/download/v2026.10.02/${name}`,
});

describe("fetchLatestDesktopRelease", () => {
  beforeEach(() => invalidateReleaseFeedCache());

  it("reads the latest date release and its two installers", async () => {
    const fetchImpl = fakeFetch({
      [LATEST]: {
        status: 200,
        body: JSON.stringify({
          tag_name: "v2026.10.02",
          assets: [asset("Mediary.Scout-2026.1002.0-arm64.dmg"), asset("Mediary.Scout.Setup.2026.1002.0.exe"), asset("notes.txt")],
        }),
      },
    });
    expect(await fetchLatestDesktopRelease(fetchImpl)).toEqual({
      tag: "v2026.10.02",
      pageUrl: "https://github.com/xixjohan/mediary-scout/releases/tag/v2026.10.02",
      dmgUrl: asset("Mediary.Scout-2026.1002.0-arm64.dmg").browser_download_url,
      exeUrl: asset("Mediary.Scout.Setup.2026.1002.0.exe").browser_download_url,
    });
  });

  it("callers that arrive while the lookup is running share it", async () => {
    const fetchImpl = fakeFetch({
      [LATEST]: {
        status: 200,
        body: JSON.stringify({
          tag_name: "v2026.10.02",
          assets: [asset("Mediary.Scout-2026.1002.0-arm64.dmg"), asset("Mediary.Scout.Setup.2026.1002.0.exe")],
        }),
      },
    });
    const [first, second] = await Promise.all([fetchLatestDesktopRelease(fetchImpl), fetchLatestDesktopRelease(fetchImpl)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("ignores an old semver release, and installers served from anywhere else", async () => {
    const old = fakeFetch({ [LATEST]: { status: 200, body: JSON.stringify({ tag_name: "v1.4.1", assets: [] }) } });
    expect(await fetchLatestDesktopRelease(old)).toBeNull();
    invalidateReleaseFeedCache();
    const elsewhere = fakeFetch({
      [LATEST]: {
        status: 200,
        body: JSON.stringify({
          tag_name: "v2026.10.02",
          assets: [
            { name: "a.dmg", browser_download_url: "https://elsewhere.example/a.dmg" },
            { name: "a.exe", browser_download_url: "https://elsewhere.example/a.exe" },
          ],
        }),
      },
    });
    expect(await fetchLatestDesktopRelease(elsewhere)).toBeNull();
  });

  it("returns null when only the .exe uploaded so far", async () => {
    const onlyExe = fakeFetch({
      [LATEST]: {
        status: 200,
        body: JSON.stringify({
          tag_name: "v2026.10.02",
          assets: [asset("Mediary.Scout.Setup.2026.1002.0.exe")],
        }),
      },
    });
    expect(await fetchLatestDesktopRelease(onlyExe)).toBeNull();
  });

  it("treats a release that is still missing an installer as a five-minute failure", async () => {
    const failTtl = 5 * 60 * 1000;
    const onlyExe = JSON.stringify({
      tag_name: "v2026.10.02",
      assets: [asset("Mediary.Scout.Setup.2026.1002.0.exe")],
    });
    const both = JSON.stringify({
      tag_name: "v2026.10.02",
      assets: [asset("Mediary.Scout-2026.1002.0-arm64.dmg"), asset("Mediary.Scout.Setup.2026.1002.0.exe")],
    });
    let body = onlyExe;
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    vi.useFakeTimers();
    try {
      const start = new Date("2026-10-02T00:00:00.000Z");
      vi.setSystemTime(start);
      expect(await fetchLatestDesktopRelease(fetchImpl)).toBeNull();
      vi.setSystemTime(new Date(start.getTime() + failTtl - 1));
      expect(await fetchLatestDesktopRelease(fetchImpl)).toBeNull();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      body = both;
      vi.setSystemTime(new Date(start.getTime() + failTtl));
      expect(await fetchLatestDesktopRelease(fetchImpl)).toEqual({
        tag: "v2026.10.02",
        pageUrl: "https://github.com/xixjohan/mediary-scout/releases/tag/v2026.10.02",
        dmgUrl: asset("Mediary.Scout-2026.1002.0-arm64.dmg").browser_download_url,
        exeUrl: asset("Mediary.Scout.Setup.2026.1002.0.exe").browser_download_url,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null when GitHub is unreachable, and caches the failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchLatestDesktopRelease(fetchImpl)).toBeNull();
    expect(await fetchLatestDesktopRelease(fetchImpl)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("updateRepoSlug（S5.6：在线更新源可配置）", () => {
  const original = process.env.MEDIA_TRACK_UPDATE_REPO;

  afterEach(() => {
    if (original === undefined) delete process.env.MEDIA_TRACK_UPDATE_REPO;
    else process.env.MEDIA_TRACK_UPDATE_REPO = original;
    invalidateReleaseFeedCache();
  });

  it("默认指向**当前仓库**（未设 env 时）——S5.6 需求原文", () => {
    delete process.env.MEDIA_TRACK_UPDATE_REPO;
    expect(updateRepoSlug()).toBe("xixjohan/mediary-scout");
    expect(DEFAULT_UPDATE_REPO).toBe("xixjohan/mediary-scout");
  });

  it("安装包只信默认源的 release 下载（源指错 = 更新检查静默失效）", () => {
    // 上面 fetchReleaseFeed / fetchLatestDesktopRelease 的夹具 URL 全部键在
    // xixjohan/mediary-scout 上，且那些用例不设 env（走默认源）——它们绿，
    // 就等于默认源的 tags/notes/安装包三类 URL 都指向当前仓库。
    delete process.env.MEDIA_TRACK_UPDATE_REPO;
    expect(updateRepoSlug()).toBe("xixjohan/mediary-scout");
  });

  it("env 可覆盖成任意 owner/name（含指回上游）", () => {
    process.env.MEDIA_TRACK_UPDATE_REPO = "xixjohan/mediary-scout";
    expect(updateRepoSlug()).toBe("xixjohan/mediary-scout");
    process.env.MEDIA_TRACK_UPDATE_REPO = "someone/mediary-scout";
    expect(updateRepoSlug()).toBe("someone/mediary-scout");
  });

  it("空串/空白按未设处理（回落到默认 = 当前仓库）", () => {
    process.env.MEDIA_TRACK_UPDATE_REPO = "   ";
    expect(updateRepoSlug()).toBe("xixjohan/mediary-scout");
  });

  it("拒绝畸形值（缺 owner、含空格、URL 形态、三段路径）", () => {
    for (const bad of ["just-a-name", "owner/name with space", "https://github.com/a/b", "a/b/c"]) {
      process.env.MEDIA_TRACK_UPDATE_REPO = bad;
      expect(() => updateRepoSlug()).toThrow();
    }
  });

  it("feed 指向 env 指定的仓库", async () => {
    process.env.MEDIA_TRACK_UPDATE_REPO = "xixjohan/mediary-scout";
    invalidateReleaseFeedCache();
    const tags = "https://api.github.com/repos/xixjohan/mediary-scout/git/matching-refs/tags/v";
    const fetchImpl = fakeFetch({
      [tags]: { status: 200, body: JSON.stringify([ref("v2026.10.26", "f".repeat(40))]) },
      ["https://api.github.com/repos/xixjohan/mediary-scout/contents/release-notes/v2026.10.26.md?ref=v2026.10.26"]:
        { status: 200, body: "- 新增 自包含更新" },
    });
    const feed = await fetchReleaseFeed(fetchImpl);
    expect(feed.map((entry) => entry.tag)).toEqual(["v2026.10.26"]);
  });
});
