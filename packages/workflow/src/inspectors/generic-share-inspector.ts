import type { ResourceCandidate, ResourceType } from "../domain/domain.js";
import type {
  IShareInspectorAdapter,
  ResourceInspectionResult,
} from "./share-inspector-types.js";

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

    // 磁力链接基本判定
    if (candidate.type === "magnet" || url.startsWith("magnet:")) {
      return {
        candidateId: candidate.id,
        status: url ? "valid" : "invalid",
        totalSizeBytes: sizeBytes,
        message: url ? "磁力哈希就绪" : "无效的磁力地址",
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

    // 其他网盘兜底：链接存在即判定为就绪
    return {
      candidateId: candidate.id,
      status: "valid",
      totalSizeBytes: sizeBytes,
      message: "资源链接就绪",
      probedAt: now,
    };
  }
}
