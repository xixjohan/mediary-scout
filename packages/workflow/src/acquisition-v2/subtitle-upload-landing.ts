import type { StorageV2 } from "./storage-115-simulator.js";

export type SubtitleUploadOutcome =
  | { outcome: "landed"; key: string; filename: string }
  | { outcome: "deferred"; key: string; file: { url: string; filename: string } };

/** Try to land subtitle files by UPLOAD instead of an offline task (upload does
 *  not consume the monthly cloud-download quota). Returns one entry per input
 *  file: `landed` for a 秒传 hit, otherwise the file is handed back so the
 *  caller can fall back to the offline-task path.
 *
 * 静默降级是设计意图：executor 没有上传能力、本机访问不到 assrt 直链、文件
 * 超限、平台上传服务不可用——任何一种都只是「这条路径这次不适用」，绝不为
 * 一个软目标抛错或让用户看到一次「上传失败」。 */
export async function landSubtitlesByUpload(
  storage: StorageV2,
  files: Array<{ key: string; url: string; filename: string }>,
  directoryId: string,
): Promise<SubtitleUploadOutcome[]> {
  if (!storage.uploadSubtitle) {
    return files.map((file) => ({ outcome: "deferred" as const, key: file.key, file }));
  }
  const outcomes: SubtitleUploadOutcome[] = [];
  for (const file of files) {
    let landed = false;
    try {
      landed =
        (
          await storage.uploadSubtitle({
            url: file.url,
            filename: file.filename,
            directoryId,
          })
        ).outcome === "landed";
    } catch {
      landed = false;
    }
    outcomes.push(
      landed
        ? { outcome: "landed", key: file.key, filename: file.filename }
        : { outcome: "deferred", key: file.key, file },
    );
  }
  return outcomes;
}