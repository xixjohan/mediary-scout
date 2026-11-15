import { classifyDriveApiCall, type DriveApiQuotaClass } from "./drive-api-quota.js";

/**
 * 网盘 API 分类计量器（任务单：下载类计数独立显示）。
 *
 * 为什么是**旁路**而不是塞进 Pan115ApiGuard：guard 的调用硬限是为**单次采集
 * 运行**设计的，而直链解析是用户交互、跨月持续的行为（播放一次解析一次），
 * 两者语义冲突。塞进 guard 会改变调用路径与限流行为，违反「纯观测」原则。
 *
 * 计量作用域 = **本次任务内**（与 trace 的 `apiCalls`「开始前累计值」语义一致）。
 * 刻意不做月度持久化：UI 只展示任务内次数，不展示月限额，跨月累计没有消费方。
 *
 * 纪律：
 *   - `record()` **绝不抛错**——纯观测不能阻断业务调用
 *   - `record()` **不存储 URL**——URL 只用来做协议判定，判完即丢，避免凭据
 *     与直链进入任何可观测表面
 */

export interface DriveApiMeterSnapshot {
  /** 有月度限额的调用次数（直链解析／http 离线任务／离线任务管理）。 */
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
  /** 清零（一次采集任务开始时）。 */
  reset(): void;
}

/** 进程内计量器。多 worker（external 模式）下各 worker 只累计自己发出的调用。 */
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

  reset(): void {
    this.download = 0;
    this.free = 0;
  }
}

/** 共享单例：guard（采集侧）与 stream-resolver（播放侧）都向它上报。 */
export const driveApiMeter: DriveApiMeter = new InMemoryDriveApiMeter();

/** 分类常量的再导出，方便调用方只引一个模块。 */
export type { DriveApiQuotaClass };
