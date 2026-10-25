import { parseReleaseTag } from "@media-track/shared";

/** The app version a release tag ships as: v2026.09.28 → 2026.928.0, v2026.09.28.2 → 2026.928.2.
 *  Valid semver (no leading zeros), ordered like the tags, and above every 1.x release. Null for
 *  anything that is not a release tag, including dates that do not exist. */
export function appVersionFromTag(tag: string): string | null {
  const parsed = parseReleaseTag(tag);
  if (!parsed) return null;
  const [year, month, day] = parsed.date.split("-").map(Number) as [number, number, number];
  return `${year}.${month * 100 + day}.${parsed.seq}`;
}

/** True when `candidate` (x.y.z) is newer than `current`. Unparseable input is never newer. */
export function isNewerAppVersion(candidate: string, current: string): boolean {
  const next = parseAppVersion(candidate);
  const running = parseAppVersion(current);
  if (!next || !running) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== running[index]) return next[index]! > running[index]!;
  }
  return false;
}

function parseAppVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
