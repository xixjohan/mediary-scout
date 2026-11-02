import type { ResourceCandidate, ResourceType } from "../domain/domain.js";

/**
 * 资源有效性状态机（FSM）
 */
export type ResourceValidityStatus =
  | "idle"
  | "probing"
  | "valid"
  | "invalid"
  | "password_required"
  | "rate_limited"
  | "unknown";

/**
 * 网盘/资源文件树节点（兼容单文件与多层级文件夹）
 */
export interface ResourceFileNode {
  id: string;
  name: string;
  isDir: boolean;
  sizeBytes?: number | undefined;
  updatedAt?: string | undefined;
  children?: ResourceFileNode[] | undefined;
}

/**
 * 资源探测结果安全领域模型（严禁泄露 URL 和提取码）
 */
export interface ResourceInspectionResult {
  candidateId: string;
  status: ResourceValidityStatus;
  message?: string | undefined;
  totalSizeBytes?: number | undefined;
  fileCount?: number | undefined;
  files?: ResourceFileNode[] | undefined;
  probedAt: string;
}

/**
 * 网盘资源探测适配器接口（Adapter Pattern）
 */
export interface IShareInspectorAdapter {
  readonly supportedTypes: readonly ResourceType[];
  inspect(candidate: ResourceCandidate): Promise<ResourceInspectionResult>;
}
