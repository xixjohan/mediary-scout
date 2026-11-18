import type { ResourceCandidate, ResourceType } from "../domain/domain.js";
import type {
  IShareInspectorAdapter,
  ResourceInspectionResult,
} from "./share-inspector-types.js";

/**
 * 兜底适配器：**只对磁力这类「不需要网盘账号就能判定」的链接给出结论**。
 *
 * 以前它把 123 / 天翼 / 光鸭 也登记进来，并对任何非空 URL 直接报 `valid` ——
 * 那不是探测，是猜。用户看到「有效」去投放，实际分享可能早已失效；面板上也
 * 再没有「待探测」这个诚实的中间态。现在这些品牌由
 * `CredentialedShareInspectorAdapter`（带登录态的真实列目录）接管；没有绑定
 * 账号凭据时，它们会落到本类的 `unknown`，前端显示「未校验」。
 */
export class GenericShareInspectorAdapter implements IShareInspectorAdapter {
  readonly supportedTypes: readonly ResourceType[] = [
    "magnet",
    "123",
    "tianyi",
    "guangya",
    "manual",
  ];

  async inspect(candidate: ResourceCandidate): Promise<ResourceInspectionResult> {
    const now = new Date().toISOString();
    const payload = candidate.providerPayload ?? {};
    const url = typeof payload["url"] === "string" ? payload["url"] : "";
    const sizeBytes =
      typeof payload["sizeBytes"] === "number" && payload["sizeBytes"] > 0
        ? Math.round(payload["sizeBytes"])
        : undefined;

    if (candidate.type === "magnet" || url.startsWith("magnet:")) {
      return {
        candidateId: candidate.id,
        status: url ? "valid" : "invalid",
        totalSizeBytes: sizeBytes,
        message: url ? "磁力地址已就绪（存活需由下载端确认）" : "无效的磁力地址",
        probedAt: now,
      };
    }

    if (!url) {
      return {
        candidateId: candidate.id,
        status: "invalid",
        message: "未包含有效链接地址",
        probedAt: now,
      };
    }

    // 需要登录态才能确认在场的品牌：没有适配器就没有结论，如实报 unknown。
    return {
      candidateId: candidate.id,
      status: "unknown",
      totalSizeBytes: sizeBytes,
      message: "该网盘需要登录态才能校验，选好目标网盘后再探测",
      probedAt: now,
    };
  }
}
