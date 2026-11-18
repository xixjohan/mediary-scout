import type { ResourceCandidate } from "../domain/domain.js";
import type {
  IShareInspectorAdapter,
  ResourceFileNode,
  ResourceInspectionResult,
} from "./share-inspector-types.js";

/**
 * 需要「登录态」才能探活的网盘（123 / 天翼 / 光鸭）的探测适配器。
 *
 * 为什么单独一层：115 与夸克/UC 的分享详情有匿名入口（webapi/share/snap、
 * sharepage/token），探测适配器自带 fetch 就能工作；而 123 / 天翼 / 光鸭的
 * 分享列表接口要求登录态 cookie/token（「空码穿透」）。协议实现留在各自的
 * 品牌 client 里，这里只接收一个**已绑定了账号凭据的探针函数**，
 * 因而探测器本身不接触存储层，也便于用假 client 单测。
 *
 * 判定口径（保守，与死链记录同一原则：宁可 unknown 也不误杀）：
 *  - 接口报「失效/取消/不存在/提取码错误」→ invalid / password_required；
 *  - 接口限流 → rate_limited（不缓存，下一轮重试）；
 *  - 列出 0 个条目 → 依赖品牌语义（由探针直接给出 invalid 或 listed 空表）；
 *  - 其他异常（网络/超时）→ unknown —— 一次抖动不能把好资源标成死链。
 */

export interface ShareProbeFile {
  name: string;
  sizeBytes?: number | undefined;
  isDir: boolean;
}

export type ShareProbeOutcome =
  | { kind: "listed"; files: ShareProbeFile[] }
  | { kind: "invalid"; message: string }
  | { kind: "password_required"; message: string }
  | { kind: "rate_limited"; message: string }
  | { kind: "unknown"; message: string };

export type CredentialedShareProbe = (candidate: ResourceCandidate) => Promise<ShareProbeOutcome>;

export interface CredentialedShareInspectorOptions {
  /** 该探针负责的资源类型。 */
  types: readonly ResourceCandidate["type"][];
  probe: CredentialedShareProbe;
  /** 列目录结果为空时的判定。光鸭的半失效分享「摘要与 token 都成功但列不出文件」，
   *  那种情况判 unknown 更安全；123/天翼空列表则意味着转存必然失败。 */
  emptyMeans?: "invalid" | "unknown";
}

function toNodes(files: ShareProbeFile[]): ResourceFileNode[] {
  return files.map((file, index) => ({
    id: `node-${index + 1}`,
    name: file.name,
    isDir: file.isDir,
    ...(file.sizeBytes === undefined ? {} : { sizeBytes: file.sizeBytes }),
  }));
}

export class CredentialedShareInspectorAdapter implements IShareInspectorAdapter {
  readonly supportedTypes: readonly ResourceCandidate["type"][];
  private readonly probe: CredentialedShareProbe;
  private readonly emptyMeans: "invalid" | "unknown";

  constructor(options: CredentialedShareInspectorOptions) {
    this.supportedTypes = options.types;
    this.probe = options.probe;
    this.emptyMeans = options.emptyMeans ?? "invalid";
  }

  async inspect(candidate: ResourceCandidate): Promise<ResourceInspectionResult> {
    const probedAt = new Date().toISOString();
    try {
      const outcome = await this.probe(candidate);
      switch (outcome.kind) {
        case "listed": {
          if (outcome.files.length === 0) {
            return {
              candidateId: candidate.id,
              status: this.emptyMeans,
              message: this.emptyMeans === "invalid" ? "分享中没有任何文件，无法转存" : "分享没有列出文件（可能已失效或受限）",
              probedAt,
            };
          }
          const nodes = toNodes(outcome.files);
          const totalSizeBytes = outcome.files.reduce(
            (sum, file) => sum + (file.isDir ? 0 : (file.sizeBytes ?? 0)),
            0,
          );
          return {
            candidateId: candidate.id,
            status: "valid",
            fileCount: nodes.length,
            files: nodes,
            ...(totalSizeBytes > 0 ? { totalSizeBytes } : {}),
            probedAt,
          };
        }
        case "invalid":
        case "password_required":
        case "rate_limited":
          return { candidateId: candidate.id, status: outcome.kind, message: outcome.message, probedAt };
        case "unknown":
          return { candidateId: candidate.id, status: "unknown", message: outcome.message, probedAt };
      }
    } catch (error) {
      // 探针抛错 = 没拿到权威结论（网络/协议），一律 unknown，绝不判失效。
      return {
        candidateId: candidate.id,
        status: "unknown",
        message: error instanceof Error ? error.message : "网盘探测失败",
        probedAt,
      };
    }
  }
}

/** 从品牌 client 抛出的错误文案里识别「分享确实死了」。
 *
 *  这些品牌都没有独立的「分享状态」接口，只能靠列表/换 token 的报错文本。
 *  只匹配**确定的**死亡信号；模糊错误留给 unknown。 */
export function classifyShareProbeErrorMessage(message: string): "invalid" | "password_required" | null {
  if (/提取码|访问码|access_?code|passcode|password/i.test(message)) return "password_required";
  if (/失效|不存在|已取消|链接错误|删除|dead|not found|invalid/i.test(message)) return "invalid";
  return null;
}
