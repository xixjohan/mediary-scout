/**
 * 网盘 API 的限额类别分类（任务单：下载类计数独立显示）。
 *
 * 平台侧的额限语义（用户提供的领域知识，代码中不可推导）：
 *   - 转存类（receiveShare / 磁力秒传）**无月限**
 *   - 直链解析、http 离线任务（服务端真实拉取）、离线任务管理**有月限**
 *   - 文件上传**不消耗额度**
 *
 * 115 开放平台 2026-08 曾单方面暂停服务，且各平台对同类操作的计额政策不同，
 * 因此分类必须是**按平台隔离的适配器**，未登记平台一律归 `free`——把无额限
 * 操作错标成有额限会造成虚假告警，比漏报更糟。
 *
 * 刻意只用两个类别：UI 只展示「本次任务内调用次数」，不展示额度、不计算余量，
 * 细分类没有展示收益，只是白增映射维护成本。
 */

/** 网盘 API 的限额类别。UI 与 trace 都以此为主键。 */
export type DriveApiQuotaClass = "download" | "free";

/** 该类别是否有月度限额——给 UI 与文案用，避免各处硬编码字符串判断。 */
export function hasMonthlyQuota(quotaClass: DriveApiQuotaClass): boolean {
  return quotaClass === "download";
}

/** 离线任务／转存提交的 URL 协议：决定同一次 `addOfflineTask` 是秒传还是服务端拉取。 */
const INSTANT_TRANSFER_PROTOCOLS: ReadonlySet<string> = new Set(["magnet:", "ed2k:"]);

/**
 * 115 的操作分类。**同一个操作名可能分属两类**——`addOfflineTask` 接磁力是
 * 秒传（无额限），接 http(s) 字幕直链是服务端真实拉取（有额限），所以必须
 * 看 URL 协议，不能只看操作名。
 *
 * 纯函数、无 I/O，可单测。
 */
export function classifyPan115Operation(operation: string, url?: string): DriveApiQuotaClass {
  switch (operation) {
    // 接收分享：平台侧一次转存，无月限。
    case "receiveShare":
      return "free";
    // 离线任务：按 URL 协议分流。磁力/ed2k 是秒传；http/https/ftp 是服务端
    // 从第三方拉取，真实消耗云下载配额。
    case "addOfflineTask":
      return url !== undefined && isInstantTransferUrl(url) ? "free" : "download";
    // 离线任务管理（轮询与取消）与直链下载共享月限（用户口径）。
    case "listOfflineTasks":
    case "removeOfflineTask":
      return "download";
    // 目录与文件管理：结构化元数据操作，无月限。
    default:
      return "free";
  }
}

/** 秒传类 URL：磁力与 ed2k 链接由平台侧哈希匹配完成，不产生持续流量。 */
export function isInstantTransferUrl(url: string): boolean {
  const trimmed = url.trimStart().toLowerCase();
  for (const protocol of INSTANT_TRANSFER_PROTOCOLS) {
    if (trimmed.startsWith(protocol)) return true;
  }
  return false;
}

/** 各平台的 (operation, url?) → 类别 映射。未登记平台不在表内。 */
type DriveQuotaClassifier = (operation: string, url?: string) => DriveApiQuotaClass;

const PLATFORM_CLASSIFIERS: Record<string, DriveQuotaClassifier> = {
  pan115: classifyPan115Operation,
};

/**
 * 按平台分类一个操作。**未登记平台一律 `free`**：新网盘接入时默认不计量下载类，
 * 由平台方确认计额政策后再显式登记——宁可漏报也不虚假告警。
 */
export function classifyDriveApiCall(
  platform: string,
  operation: string,
  url?: string,
): DriveApiQuotaClass {
  return PLATFORM_CLASSIFIERS[platform]?.(operation, url) ?? "free";
}
