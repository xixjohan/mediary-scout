import { classifyDriveApiCall, type DriveApiQuotaClass } from "./drive-api-quota.js";

/**
 * 网盘 API 分类计量器（任务单：下载类计数独立显示）。
 *
 * 为什么是**旁路**而不是塞进 Pan115ApiGuard：guard 承载调用硬限与限流，塞进去
 * 会改变调用路径与限流行为，违反「纯观测」原则。
 *
 * 计量作用域 = **本次任务内**，由 executor **自持一个实例**达成——每次采集运行
 * 经 factory 新建 executor（与 `apiGuard.callsSpent()` 的 `apiCalls` 完全对称）。
 * 刻意不用进程级单例：那会跨任务累加，且把 STRM 播放侧的直链解析混进任务计数。
 * 也刻意不做月度持久化：UI 只展示任务内次数，不展示月限额。
 *
 * 纪律：
 *   - `record()` **绝不抛错**——纯观测不能阻断业务调用
 *   - `record()` **不存储 URL**——URL 只用来做协议判定，判完即丢，避免凭据
 *     与直链进入任何可观测表面
 */

export interface DriveApiMeterSnapshot {
  /** 有月度限额的调用次数（http 离线任务／离线任务管理）。 */
  download: number;
  /** 无月限的调用次数（秒传转存／目录与文件管理）。 */
  free: number;
  /** 总和，等于 download + free。 */
  total: number;
}

export interface DriveApiMeter {
  /** 上报一次调用。url 仅用于协议判定，不被存储。 */
  record(platform: string, operation: string, url?: string): void;
  /** 本次任务内的分类计数。 */
  snapshot(): DriveApiMeterSnapshot;
}

/** 每个 executor 一个实例，生命周期即一次采集运行。 */
export class InMemoryDriveApiMeter implements DriveApiMeter {
  private download = 0;
  private free = 0;

  record(platform: string, operation: string, url?: string): void {
    // 分类是纯函数，不会抛；但观测绝不能成为故障源，仍然兜住。
    try {
      if (classifyDriveApiCall(platform, operation, url) === "download") {
        this.download += 1;
      } else {
        this.free += 1;
      }
    } catch {
      // 观测失败静默丢弃：绝不让计量影响业务调用。
    }
  }

  snapshot(): DriveApiMeterSnapshot {
    return { download: this.download, free: this.free, total: this.download + this.free };
  }
}

/** 分类常量的再导出，方便调用方只引一个模块。 */
export type { DriveApiQuotaClass };
