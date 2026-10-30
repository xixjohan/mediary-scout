import Link from "next/link";
import { showHref } from "@media-track/workflow";
import type { LibraryWallEntry } from "../../../lib/title-hub";

/**
 * 订阅页「缺失待办区」。
 *
 * 这个页面正名为「订阅」后，用户对它的预期是「我在追什么、还缺什么」——一墙
 * 海报答不了后半句。这块直接说「还缺哪些集、缺多少」。
 *
 * 数据口径：`missingAiredCount` 来自 `../lib/subscription-missing` 的共享判定
 * （与 /api/agent/library 的 missingAired、详情页季行的 missingAiredCount 同一个），
 * 这里只做筛选与排序，**不重新计算缺失**。
 *
 * 为什么排序是「缺失多的在前」：用户点进订阅页通常是想知道「还有什么没看完」，
 * 缺 12 集的比缺 1 集的更该被看见。同数按标题排序保证结果稳定（不随 DB 返回序抖动）。
 */
export function missingAiredTitles(wallEntries: LibraryWallEntry[]): LibraryWallEntry[] {
  return wallEntries
    .filter((entry) => entry.missingAiredCount > 0)
    .sort((a, b) => b.missingAiredCount - a.missingAiredCount || a.title.localeCompare(b.title, "zh-Hans-CN"));
}

export function SubscriptionTodo({
  wallEntries,
  storageId,
}: {
  wallEntries: LibraryWallEntry[];
  storageId?: string | undefined;
}) {
  const todo = missingAiredTitles(wallEntries);
  // 没有缺失就整块不渲染——一个写着「还缺 0 集」的标题栏比没有更吵。
  if (todo.length === 0) {
    return null;
  }
  const totalMissing = todo.reduce((sum, entry) => sum + entry.missingAiredCount, 0);

  return (
    <section className="subscription-todo">
      <header className="subscription-todo-head">
        <h2>还缺 {totalMissing} 集</h2>
        <span className="quiet">共 {todo.length} 部 · 按缺失集数排序</span>
      </header>
      <ul className="subscription-todo-list">
        {todo.map((entry) => (
          <li key={entry.tmdbId}>
            <Link href={showHref(entry.tmdbId, "library", storageId, entry.type)}>
              <span className="subscription-todo-title">{entry.title}</span>
              <span className="subscription-todo-year">{entry.year}</span>
              <span className="subscription-todo-count">缺 {entry.missingAiredCount} 集</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
