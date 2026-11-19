import { TriangleAlert } from "lucide-react";
import { BackLink } from "../../../components/layout/back-link";

/**
 * `/show/[tmdbId]` 的空态。两种情形必须分开说：
 *
 *  - `validTmdbId === false`：链接本身不是作品页（例如 `/show/0`——TMDB 没有 0 号，
 *    它只可能来自一条无作品身份的记录）。提示用户「去搜索页重新查找」只会更困惑，
 *    因为他手上根本没有一部作品。
 *  - `validTmdbId === true`：id 合法但 TMDB / 库内都查不到，那才是「没找到」。
 *
 * 单独成组件的理由：页面文件已顶到 600 行上限，且这个分支会把 ShowContent 的
 * 复杂度推过阈值——两者都会让「加一行守卫」变成一次 lint 危机。
 */
export function ShowNotFound({
  validTmdbId,
  backLabel,
  backHref,
}: {
  validTmdbId: boolean;
  backLabel: string;
  backHref: string;
}) {
  return (
    <div className="quiet-state">
      <BackLink label={backLabel} fallbackHref={backHref} />
      <TriangleAlert size={24} aria-hidden />
      {validTmdbId ? (
        <>
          <strong>没有找到这部影片</strong>
          <span>回到搜索页重新查找。</span>
        </>
      ) : (
        <>
          <strong>这个链接不是有效的作品页</strong>
          <span>请从影视库或搜索页重新进入。</span>
        </>
      )}
    </div>
  );
}
