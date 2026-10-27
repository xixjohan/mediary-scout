import { appVersionFromTag, isNewerAppVersion } from "./release-version.js";

/**
 * 桌面自更新检查的仓库——**与服务的在线更新源（S5.6，apps/web/lib/release-feed-server.ts）
 * 是两条独立通道**：那条管 Docker 镜像/发布 tag，这条管桌面安装包（.dmg/.exe 只由
 * 发安装包的那个仓库提供）。默认值仍指上游安装包渠道：改成本仓库会让现有桌面安装
 * 收不到更新（fork 不发安装包），那是另一种「静默分歧」。
 * fork 若要自己发桌面安装包，设 MEDIA_TRACK_UPDATE_REPO=<owner>/<name> 覆盖。
 */
/**
 * 覆盖后的仓库。写成函数而非模块常量：env 在进程生命周期内可改（测试与
 * fork 的部署脚本都会改），模块级常量会把首次 import 时的值冻住。
 */
export function getUpdateRepo(): string {
  const fromEnv = process.env.MEDIA_TRACK_UPDATE_REPO?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : "fancydirty/mediary-scout";
}

export function getReleasesLatestUrl(): string {
  return `https://api.github.com/repos/${getUpdateRepo()}/releases/latest`;
}
/** Wall-clock time between successful checks. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface LatestRelease {
  tag: string;
  version: string;
  /** The release on GitHub: what changed, and both installers. */
  pageUrl: string;
}

/** Installers are only trusted from this repo's own release downloads. */
function downloadPrefix(): string {
  return `https://github.com/${getUpdateRepo()}/releases/download/`;
}

/** GitHub's releases/latest body → the release, or null when it is not a date release (v1.4.1)
 *  or it does not yet include both a .dmg and an .exe from this repo. The release is created
 *  before the assets finish uploading. The page URL is built from the checked tag, never taken
 *  from the response. */
export function parseLatestRelease(body: unknown): LatestRelease | null {
  if (!body || typeof body !== "object") return null;
  const data = body as { tag_name?: unknown; assets?: unknown };
  const tag = data.tag_name;
  if (typeof tag !== "string") return null;
  const version = appVersionFromTag(tag);
  if (!version) return null;
  if (!hasOwnInstaller(data.assets, ".dmg") || !hasOwnInstaller(data.assets, ".exe")) return null;
  return { tag, version, pageUrl: `https://github.com/${getUpdateRepo()}/releases/tag/${tag}` };
}

function hasOwnInstaller(assets: unknown, extension: string): boolean {
  if (!Array.isArray(assets)) return false;
  return assets.some((asset) => {
    if (!asset || typeof asset !== "object") return false;
    const item = asset as { name?: unknown; browser_download_url?: unknown };
    return (
      typeof item.name === "string" &&
      item.name.endsWith(extension) &&
      typeof item.browser_download_url === "string" &&
      item.browser_download_url.startsWith(downloadPrefix())
    );
  });
}

/** Offer only a newer release, and notify once per release. */
export function decideUpdateNotice(input: {
  latest: LatestRelease | null;
  currentVersion: string;
  notifiedTag: string | null;
}): { offer: LatestRelease | null; notify: boolean } {
  const offer = input.latest && isNewerAppVersion(input.latest.version, input.currentVersion) ? input.latest : null;
  return { offer, notify: offer !== null && offer.tag !== input.notifiedTag };
}

/** Due when never checked, a day has passed, or the clock went backwards. */
export function shouldCheckForUpdate(input: { now: number; lastCheckedAt: number | null }): boolean {
  if (input.lastCheckedAt === null) return true;
  return input.now < input.lastCheckedAt || input.now - input.lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS;
}
