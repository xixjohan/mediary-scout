import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { compareReleaseTags, parseReleaseNotes, parseReleaseTag, type ReleaseNote } from "./release-version";
import { normalizeCommit } from "./deployment-update";

/**
 * 在线更新源（S5.6，需求 #5）：完全独立指向**当前仓库** `xixjohan/mediary-scout`。
 * 与原仓库完全解耦，不再依赖或回退到原仓库地址。
 * 如需配置其他镜像源，使用 `MEDIA_TRACK_UPDATE_REPO=<owner>/<name>` 显式指定。
 */
export const DEFAULT_UPDATE_REPO = "xixjohan/mediary-scout";

export function updateRepoSlug(): string {
  const raw = (process.env.MEDIA_TRACK_UPDATE_REPO ?? "").trim();
  if (!raw) return DEFAULT_UPDATE_REPO;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) {
    throw new Error(
      `MEDIA_TRACK_UPDATE_REPO_INVALID: "${raw}" — 必须是 owner/name 形态（如 xixjohan/mediary-scout）`,
    );
  }
  return raw;
}

const OK_TTL_MS = 60 * 60 * 1000;
const FAIL_TTL_MS = 5 * 60 * 1000;
const NOTES_LIMIT = 10;

export interface ReleaseEntry {
  tag: string;
  date: string;
  commit: string;
  notes: ReleaseNote[];
}

/** The newest Release that already has both installers: what desktop users can download. */
export interface DesktopRelease {
  tag: string;
  pageUrl: string;
  dmgUrl: string | null;
  exeUrl: string | null;
}

let cache: { at: number; ttl: number; feed: ReleaseEntry[] } | null = null;
let desktopCache: { at: number; ttl: number; release: DesktopRelease | null } | null = null;
const relationCache = new Map<string, { at: number; relation: CommitRelation | null }>();

let feedInFlight: Promise<ReleaseEntry[]> | null = null;
let desktopInFlight: Promise<DesktopRelease | null> | null = null;
const relationInFlight = new Map<string, Promise<CommitRelation | null>>();
let generation = 0;

export function invalidateReleaseFeedCache(): void {
  generation += 1;
  cache = null;
  desktopCache = null;
  feedInFlight = null;
  desktopInFlight = null;
  relationInFlight.clear();
  relationCache.clear();
}

/** Where `head` stands relative to `base` on GitHub. */
export type CommitRelation = "ahead" | "behind" | "identical" | "diverged";
const RELATIONS = new Set<CommitRelation>(["ahead", "behind", "identical", "diverged"]);

export async function fetchCommitRelation(
  base: string,
  head: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CommitRelation | null> {
  const key = `${base}...${head}`;
  const hit = relationCache.get(key);
  if (hit && Date.now() - hit.at < (hit.relation ? OK_TTL_MS : FAIL_TTL_MS)) return hit.relation;
  const running = relationInFlight.get(key);
  if (running) return running;
  const started = generation;
  const pending = loadCommitRelation(key, fetchImpl, started).finally(() => {
    if (relationInFlight.get(key) === pending) relationInFlight.delete(key);
  });
  relationInFlight.set(key, pending);
  return pending;
}

async function fetchRelationFromRepo(
  fetchImpl: typeof fetch,
  slug: string,
  key: string,
): Promise<{ networkOk: boolean; found: boolean; relation: CommitRelation | null }> {
  try {
    const raw = await getText(fetchImpl, `https://api.github.com/repos/${slug}/compare/${key}`);
    if (raw === null) return { networkOk: true, found: false, relation: null };
    const status = (JSON.parse(raw) as { status?: unknown }).status;
    const relation = typeof status === "string" && RELATIONS.has(status as CommitRelation) ? (status as CommitRelation) : null;
    return { networkOk: true, found: Boolean(relation), relation };
  } catch {
    return { networkOk: false, found: false, relation: null };
  }
}

async function loadCommitRelation(key: string, fetchImpl: typeof fetch, started: number): Promise<CommitRelation | null> {
  const repo = updateRepoSlug();
  const repoRes = await fetchRelationFromRepo(fetchImpl, repo, key);
  const relation = repoRes.relation;
  if (started === generation) relationCache.set(key, { at: Date.now(), relation });
  return relation;
}

async function getText(
  fetchImpl: typeof fetch,
  url: string,
  accept = "application/vnd.github+json",
): Promise<string | null> {
  const response = await fetchImpl(url, {
    headers: { "user-agent": "mediary-scout-update-check", accept },
    signal: AbortSignal.timeout(5000),
    cache: "no-store",
  });
  return response.ok ? await response.text() : null;
}

export async function fetchReleaseFeed(fetchImpl: typeof fetch = fetch): Promise<ReleaseEntry[]> {
  if (cache && Date.now() - cache.at < cache.ttl) return cache.feed;
  if (feedInFlight) return feedInFlight;
  const started = generation;
  const pending = loadReleaseFeed(fetchImpl, started).finally(() => {
    if (feedInFlight === pending) feedInFlight = null;
  });
  feedInFlight = pending;
  return pending;
}

export function readLocalReleaseNotes(tag: string): string | null {
  try {
    const candidates = [
      join(/*turbopackIgnore: true*/ process.cwd(), "docs", "release-notes", `${tag}.md`),
      join(/*turbopackIgnore: true*/ process.cwd(), "..", "..", "docs", "release-notes", `${tag}.md`),
      join(/*turbopackIgnore: true*/ process.cwd(), "release-notes", `${tag}.md`),
      join(/*turbopackIgnore: true*/ process.cwd(), "..", "..", "release-notes", `${tag}.md`),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return readFileSync(p, "utf-8");
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchFeedFromRepo(
  fetchImpl: typeof fetch,
  slug: string,
): Promise<{ networkOk: boolean; emptyOrNotFound: boolean; feed: ReleaseEntry[] }> {
  let raw: string | null = null;
  try {
    raw = await getText(fetchImpl, `https://api.github.com/repos/${slug}/git/matching-refs/tags/v`);
  } catch {
    return { networkOk: false, emptyOrNotFound: false, feed: [] };
  }

  if (raw === null) {
    return { networkOk: true, emptyOrNotFound: true, feed: [] };
  }

  try {
    const list = JSON.parse(raw) as Array<{ ref?: unknown; object?: { sha?: unknown; type?: unknown } }>;
    if (!Array.isArray(list) || list.length === 0) {
      return { networkOk: true, emptyOrNotFound: true, feed: [] };
    }

    const releases = list
      .map((item) => {
        const name = typeof item.ref === "string" ? item.ref.replace(/^refs\/tags\//, "") : "";
        const parsed = parseReleaseTag(name);
        const commit =
          item.object?.type === "commit" && typeof item.object.sha === "string" ? normalizeCommit(item.object.sha) : null;
        return parsed && commit ? { tag: parsed.tag, date: parsed.date, commit } : null;
      })
      .filter((item): item is { tag: string; date: string; commit: string } => item !== null)
      .sort((a, b) => compareReleaseTags(b.tag, a.tag));

    if (releases.length === 0) {
      return { networkOk: true, emptyOrNotFound: true, feed: [] };
    }

    const feed = await Promise.all(
      releases.map(async (release, index) => {
        if (index >= NOTES_LIMIT) return { ...release, notes: [] };
        let md = await getText(
          fetchImpl,
          `https://api.github.com/repos/${slug}/contents/docs/release-notes/${release.tag}.md?ref=${release.tag}`,
          "application/vnd.github.raw",
        ).catch(() => null);
        if (!md) {
          md = await getText(
            fetchImpl,
            `https://api.github.com/repos/${slug}/contents/release-notes/${release.tag}.md?ref=${release.tag}`,
            "application/vnd.github.raw",
          ).catch(() => null);
        }
        if (!md && fetchImpl === fetch) {
          md = readLocalReleaseNotes(release.tag);
        }
        return { ...release, notes: md ? parseReleaseNotes(md) : [] };
      }),
    );
    return { networkOk: true, emptyOrNotFound: false, feed };
  } catch {
    return { networkOk: true, emptyOrNotFound: true, feed: [] };
  }
}

export function loadLocalReleaseFeed(): ReleaseEntry[] {
  try {
    const candidates = [
      join(/*turbopackIgnore: true*/ process.cwd(), "docs", "release-notes"),
      join(/*turbopackIgnore: true*/ process.cwd(), "..", "..", "docs", "release-notes"),
      join(/*turbopackIgnore: true*/ process.cwd(), "release-notes"),
      join(/*turbopackIgnore: true*/ process.cwd(), "..", "..", "release-notes"),
    ];
    const notesDir = candidates.find((dir) => existsSync(dir));
    if (!notesDir) return [];

    const files = readdirSync(notesDir).filter((f) => f.startsWith("v") && f.endsWith(".md"));
    const entries: ReleaseEntry[] = [];
    for (const f of files) {
      const tag = f.replace(/\.md$/, "");
      const parsed = parseReleaseTag(tag);
      if (!parsed) continue;

      let commit = "";
      try {
        commit = execFileSync("git", ["rev-parse", tag], {
          encoding: "utf-8",
          timeout: 1500,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        commit = "";
      }

      const filePath = join(/*turbopackIgnore: true*/ notesDir, f);
      const content = readFileSync(filePath, "utf-8");
      entries.push({
        tag: parsed.tag,
        date: parsed.date,
        commit: normalizeCommit(commit) ?? commit,
        notes: parseReleaseNotes(content),
      });
    }

    return entries.sort((a, b) => compareReleaseTags(b.tag, a.tag));
  } catch {
    return [];
  }
}

async function loadReleaseFeed(fetchImpl: typeof fetch, started: number): Promise<ReleaseEntry[]> {
  let feed: ReleaseEntry[] = [];
  let ttl = FAIL_TTL_MS;
  const repo = updateRepoSlug();
  const res = await fetchFeedFromRepo(fetchImpl, repo);

  if (res.networkOk && res.feed.length > 0) {
    feed = res.feed;
    ttl = OK_TTL_MS;
  } else if (fetchImpl === fetch) {
    const local = loadLocalReleaseFeed();
    if (local.length > 0) {
      feed = local;
      ttl = FAIL_TTL_MS;
    }
  }

  if (started === generation) cache = { at: Date.now(), ttl, feed };
  return feed;
}

export async function fetchLatestDesktopRelease(fetchImpl: typeof fetch = fetch): Promise<DesktopRelease | null> {
  if (desktopCache && Date.now() - desktopCache.at < desktopCache.ttl) return desktopCache.release;
  if (desktopInFlight) return desktopInFlight;
  const started = generation;
  const pending = loadLatestDesktopRelease(fetchImpl, started).finally(() => {
    if (desktopInFlight === pending) desktopInFlight = null;
  });
  desktopInFlight = pending;
  return pending;
}

async function fetchDesktopReleaseFromRepo(
  fetchImpl: typeof fetch,
  slug: string,
): Promise<{ networkOk: boolean; repoHasRelease: boolean; release: DesktopRelease | null }> {
  let raw: string | null = null;
  try {
    raw = await getText(fetchImpl, `https://api.github.com/repos/${slug}/releases/latest`);
  } catch {
    return { networkOk: false, repoHasRelease: false, release: null };
  }

  if (raw === null) {
    return { networkOk: true, repoHasRelease: false, release: null };
  }

  try {
    const release = desktopReleaseFrom(JSON.parse(raw), slug);
    return { networkOk: true, repoHasRelease: true, release };
  } catch {
    return { networkOk: true, repoHasRelease: false, release: null };
  }
}

async function loadLatestDesktopRelease(fetchImpl: typeof fetch, started: number): Promise<DesktopRelease | null> {
  let release: DesktopRelease | null = null;
  let ttl = FAIL_TTL_MS;
  const repo = updateRepoSlug();
  const res = await fetchDesktopReleaseFromRepo(fetchImpl, repo);

  if (res.networkOk && res.release) {
    release = res.release;
    ttl = OK_TTL_MS;
  }

  if (started === generation) desktopCache = { at: Date.now(), ttl, release };
  return release;
}

function desktopReleaseFrom(body: unknown, slug: string): DesktopRelease | null {
  const data = (body ?? {}) as { tag_name?: unknown; assets?: unknown };
  if (typeof data.tag_name !== "string" || !parseReleaseTag(data.tag_name)) return null;
  const assets = Array.isArray(data.assets)
    ? (data.assets as Array<{ name?: unknown; browser_download_url?: unknown } | null>)
    : [];
  const downloadPrefix = `https://github.com/${slug}/releases/download/`;
  const installer = (extension: string): string | null => {
    for (const asset of assets) {
      const url = asset?.browser_download_url;
      if (typeof asset?.name === "string" && asset.name.endsWith(extension) && typeof url === "string" && url.startsWith(downloadPrefix)) {
        return url;
      }
    }
    return null;
  };
  const dmgUrl = installer(".dmg");
  const exeUrl = installer(".exe");
  if (!dmgUrl || !exeUrl) return null;
  return {
    tag: data.tag_name,
    pageUrl: `https://github.com/${slug}/releases/tag/${data.tag_name}`,
    dmgUrl,
    exeUrl,
  };
}
