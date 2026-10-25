/**
 * Release tag 解析（任务单 S4.1 的意外收获）。
 *
 * 原先是 apps/web 与 apps/desktop 各存一份逐字相同的实现，desktop 文件里
 * 写着「tests keep the two in step」——靠人肉同步的重复正是依赖门禁要消灭的
 * 东西。tag 规则无业务属主、两个宿主都要用，上收到 shared 单一事实源。
 */

/** Release tags are `vYYYY.MM.DD` (first release that day) or `vYYYY.MM.DD.N` (N ≥ 2).
 *  Only author-verified commits get a tag; instances auto-update to these and nothing else. */
export interface ReleaseTag {
  tag: string;
  /** YYYY-MM-DD */
  date: string;
  /** 0 for the day's first release, N for `.N`. */
  seq: number;
}

const TAG_RE = /^v(20\d{2})\.(0[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])(?:\.([2-9]|[1-9]\d+))?$/;

export function parseReleaseTag(value: string): ReleaseTag | null {
  const match = TAG_RE.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // The pattern allows 31 for every month; a date that rolls over (02.31 → 03.03) does not exist.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  return { tag: value, date: `${match[1]}-${match[2]}-${match[3]}`, seq: match[4] ? Number(match[4]) : 0 };
}
