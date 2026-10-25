// 窄子路径导入：barrel 会带上 credential-crypto（node:module），而本模块在
// 客户端可达链上（update-actions.tsx → update-state → release-feed-server → 此处），
// node: 内置会炸 Turbopack 客户端 chunk（S4.3 构建回归）。
import { parseReleaseTag, type ReleaseTag } from "@media-track/shared/release-tag";

// 单一事实源在 packages/shared（S4.1）：此处 re-export 保持既有调用方表面。
export { parseReleaseTag, type ReleaseTag };

export function compareReleaseTags(a: string, b: string): number {
  const left = parseReleaseTag(a);
  const right = parseReleaseTag(b);
  if (!left || !right) return a.localeCompare(b);
  return left.date.localeCompare(right.date) || left.seq - right.seq;
}

export type ReleaseNoteKind = "add" | "improve" | "fix";

export interface ReleaseNote {
  kind: ReleaseNoteKind;
  text: string;
}

const NOTE_KINDS: Record<string, ReleaseNoteKind> = { 新增: "add", 改进: "improve", 修复: "fix" };
const NOTE_RE = /^[-*]\s+(新增|改进|修复)\s+(.+?)\s*$/;

/** One bullet per note: `- 修复 <text>`. Anything else in the file is ignored. */
export function parseReleaseNotes(markdown: string): ReleaseNote[] {
  const notes: ReleaseNote[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = NOTE_RE.exec(line.trim());
    if (match) notes.push({ kind: NOTE_KINDS[match[1]!]!, text: match[2]! });
  }
  return notes;
}
