import type { ReactNode } from "react";
import { isMovieUnreleased, type MergedSourceHealth } from "@media-track/workflow";
import { AlertCircle, Calendar, RefreshCw, Search, SlidersHorizontal } from "lucide-react";

export type DiagnosticPanelState =
  | {
      kind: "streaming";
      candidates: readonly unknown[];
      progress: { done: number; total: number; currentKeyword?: string };
      sourceHealth?: MergedSourceHealth | undefined;
    }
  | {
      kind: "ready";
      candidates: readonly unknown[];
      cached: boolean;
      snapshotId: string | null;
      sourceHealth?: MergedSourceHealth | undefined;
    };

export interface ResourceEmptyDiagnosticProps {
  state: DiagnosticPanelState;
  releaseDate?: string | null | undefined;
  baseTitle?: string | undefined;
  customKeyword?: string | undefined;
  onResetKeyword?: (() => void) | undefined;
  /**
   * 当前账号能否进实例配置面（`/settings`）。
   *
   * 空状态卡片里的「前往设置」「前往网盘」两个 CTA 曾是无条件渲染，成员点了
   * 只会拿到 403 面板——空状态下最需要下一步指引的时刻把人送进死链。
   * 判据来自 `useAuth().can("system:settings")`，与页面守卫同一把钥匙。
   */
  canOpenSettings?: boolean | undefined;
  /** 当前账号能否进网盘运维页（`storage:browse_any`）。 */
  canBrowseStorage?: boolean | undefined;
}

function formatDisplayDate(dateStr: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  return match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : dateStr;
}

function renderStreamingState(
  progress: { done: number; total: number; currentKeyword?: string },
): ReactNode {
  return (
    <div className="title-resources-empty-card" role="status">
      <div className="title-resources-empty-header">
        <span className="title-resources-empty-icon" aria-hidden="true">⏳</span>
        <h4>正在检索全网资源…</h4>
      </div>
      <div className="title-resources-empty-desc">
        <p>
          已完成 {progress.done} / {progress.total} 个关键词检索
          {progress.currentKeyword ? `（当前检索：${progress.currentKeyword}）` : ""}
        </p>
      </div>
    </div>
  );
}

function renderUnreleasedCard(releaseDate: string): ReactNode {
  return (
    <div className="title-resources-empty-card" data-diagnostic="unreleased">
      <div className="title-resources-empty-header">
        <Calendar size={18} className="title-resources-empty-icon" aria-hidden="true" />
        <h4>尚未公映或尚未发布数字版</h4>
      </div>
      <div className="title-resources-empty-desc">
        <p>
          该作品预计于 <strong>{formatDisplayDate(releaseDate)}</strong> 上映或流媒体开播。在院线公映或流媒体上线前，公共检索源通常不会有可转存的高清有效资源。
        </p>
      </div>
      <div className="title-resources-empty-actions">
        <span className="title-resources-empty-btn primary">
          💡 建议在页面上方点击「预定」或「追踪」，上线后系统将自动探测追更
        </span>
      </div>
    </div>
  );
}

function renderSourceErrorCard(
  sourceHealth: MergedSourceHealth,
  canOpenSettings: boolean,
): ReactNode {
  const unhealthyNames = sourceHealth.unhealthySources.join("、") || "默认检索源";
  return (
    <div className="title-resources-empty-card" data-diagnostic="source_error">
      <div className="title-resources-empty-header">
        <AlertCircle size={18} className="title-resources-empty-icon" aria-hidden="true" />
        <h4>检索源服务响应异常</h4>
      </div>
      <div className="title-resources-empty-desc">
        <p>
          检索源（<strong>{unhealthyNames}</strong>）响应超时或格式异常。这通常是上游公开检索源短暂维护、网络连通性阻断或配置地址变动导致，并非该片不存在。
        </p>
      </div>
      {canOpenSettings ? (
        <div className="title-resources-empty-actions">
          <a href="/settings" className="title-resources-empty-btn primary">
            前往设置检查检索源与网盘
          </a>
        </div>
      ) : (
        <div className="title-resources-empty-desc">
          <p>检索源由站长维护，请稍后重试或联系站长。</p>
        </div>
      )}
    </div>
  );
}

function renderOverConstrainedCard(
  keyword: string,
  baseTitle: string,
  onResetKeyword?: () => void,
): ReactNode {
  return (
    <div className="title-resources-empty-card" data-diagnostic="over_constrained">
      <div className="title-resources-empty-header">
        <SlidersHorizontal size={18} className="title-resources-empty-icon" aria-hidden="true" />
        <h4>未检索到符合条件的资源</h4>
      </div>
      <div className="title-resources-empty-desc">
        <p>
          当前检索词为「<strong>{keyword}</strong>」，网盘或 BT 做种标题可能未包含这组特定修饰词。
        </p>
      </div>
      {onResetKeyword && (
        <div className="title-resources-empty-actions">
          <button
            type="button"
            className="title-resources-empty-btn primary"
            onClick={onResetKeyword}
          >
            <RefreshCw size={13} aria-hidden="true" />
            还原为基础片名「{baseTitle}」重新检索
          </button>
        </div>
      )}
    </div>
  );
}

function renderDefaultEmptyCard(
  canOpenSettings: boolean,
  canBrowseStorage: boolean,
): ReactNode {
  return (
    <div className="title-resources-empty-card" data-diagnostic="none">
      <div className="title-resources-empty-header">
        <Search size={18} className="title-resources-empty-icon" aria-hidden="true" />
        <h4>没有找到可获取的资源</h4>
      </div>
      <div className="title-resources-empty-desc">
        <p>全网公开网盘索引器暂未命中该片。您可以尝试：</p>
        <ul style={{ paddingLeft: "1.25rem", margin: "0.25rem 0 0" }}>
          <li>精简检索词，去除多余修饰词或压制组名称</li>
          {canBrowseStorage ? (
            <li>在顶部导航「网盘」页面，通过离线下载手动粘贴第三方磁力或直链</li>
          ) : null}
          {canOpenSettings ? <li>在「设置」中添加更多私有索引器或绑定更多网盘账号</li> : null}
        </ul>
      </div>
      {canBrowseStorage || canOpenSettings ? (
        <div className="title-resources-empty-actions">
          {canBrowseStorage ? (
            <a href="/storage" className="title-resources-empty-btn">
              前往网盘离线下载
            </a>
          ) : null}
          {canOpenSettings ? (
            <a href="/settings" className="title-resources-empty-btn">
              配置索引器
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function isSourceUnhealthy(sourceHealth: MergedSourceHealth | undefined): boolean {
  if (!sourceHealth) return false;
  return sourceHealth.status === "unreachable" || sourceHealth.status === "protocol_error";
}

/** 关键词比片名更长 = 用户自己加了修饰词把结果筛没了；返回该词以便「一键还原」。 */
function overConstrainedKeyword(
  customKeyword: string | undefined,
  baseTitle: string | undefined,
): string | null {
  const kw = customKeyword?.trim() ?? "";
  const title = baseTitle?.trim() ?? "";
  if (kw === "" || title === "" || kw === title || kw.length <= title.length) return null;
  return kw;
}

export function ResourceEmptyDiagnostic({
  state,
  releaseDate,
  baseTitle,
  customKeyword,
  onResetKeyword,
  canOpenSettings = true,
  canBrowseStorage = true,
}: ResourceEmptyDiagnosticProps): ReactNode {
  if (state.kind === "streaming") {
    return renderStreamingState(state.progress);
  }

  if (releaseDate && isMovieUnreleased(releaseDate, new Date().toISOString())) {
    return renderUnreleasedCard(releaseDate);
  }

  if (isSourceUnhealthy(state.sourceHealth)) {
    return renderSourceErrorCard(state.sourceHealth!, canOpenSettings);
  }

  const constrained = overConstrainedKeyword(customKeyword, baseTitle);
  if (constrained !== null) {
    return renderOverConstrainedCard(constrained, baseTitle?.trim() ?? "", onResetKeyword);
  }

  return renderDefaultEmptyCard(canOpenSettings, canBrowseStorage);
}
