import { nativePath as path } from "../domain/native-require.js";
import type { ResourceCandidate, ResourceSnapshot, ResourceType } from "../domain/domain.js";
import type { ResourceProvider } from "../domain/ports.js";
import type {
  DynamicProviderSearchResult,
  ExtensionEntity,
} from "./extension-types.js";
import { ForkSandboxRunner } from "./fork-sandbox-runner.js";

export class DynamicSearchProviderAdapter implements ResourceProvider {
  private readonly _entryPath: string;
  private readonly _providerName: string;

  constructor(
    public readonly extension: ExtensionEntity,
    private readonly _config?: Record<string, unknown>
  ) {
    this._entryPath = path.resolve(extension.rootDir, extension.manifest.entry);
    this._providerName = `dynamic:${extension.manifest.id}`;
  }

  public async search(input: { keyword: string; workflowRunId?: string }): Promise<ResourceSnapshot> {
    const runId = input.workflowRunId ?? `run_${Date.now()}`;
    const snapshotId = `snap_${this.extension.manifest.id}_${Date.now()}`;

    const sandboxResult = await ForkSandboxRunner.executeMethod<DynamicProviderSearchResult>(
      this._entryPath,
      "search",
      { keyword: input.keyword, config: this._config },
      { timeoutMs: 8000 }
    );

    if (!sandboxResult.success) {
      throw new Error(
        `动态资源提供商 [${this.extension.manifest.name}] 执行失败: ${sandboxResult.error || "未知错误"}`
      );
    }

    const rawCandidates = sandboxResult.data?.candidates || [];
    const mapType = (t: string): ResourceType => {
      if (t === "pan115" || t === "115") return "115";
      if (t === "quark") return "quark";
      if (t === "uc") return "uc";
      if (t === "tianyi") return "tianyi";
      if (t === "123") return "123";
      if (t === "guangya") return "guangya";
      if (t === "magnet" || t === "thunder" || t === "ed2k") return "magnet";
      return "manual";
    };
    const candidates: ResourceCandidate[] = rawCandidates.map((c, index) => ({
      id: `${snapshotId}_c_${index}`,
      snapshotId,
      index,
      title: c.title,
      type: mapType(c.type),
      source: c.source || this.extension.manifest.name,
      providerPayload: c.payload || {},
    }));

    return {
      id: snapshotId,
      provider: this._providerName,
      keyword: input.keyword,
      candidates,
      createdAt: new Date().toISOString(),
    };
  }
}
