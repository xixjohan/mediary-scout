/**
 * @media-track/contracts — 中立契约层。
 *
 * 五大 Solution 角色铁律（docs/architecture-remediation-and-governance.md §2.1）：
 *   Feature owns behavior. Contracts expose capability.
 *   Infrastructure implements technical boundaries. Composition wires implementations.
 *   Shared contains ownerless reusable capability.
 *
 * 本包零第三方依赖、零业务逻辑，只放端口定义与 DTO。
 */

export type { FileMetadata, IStorageDriver, StorageBrand } from "./infrastructure-ports/IStorageDriver.js";
export type { IJobQueue, Job, JobStatus, EnqueueJobInput } from "./infrastructure-ports/IJobQueue.js";
export type { ISearchProvider, ResourceCandidate, SearchQuery } from "./infrastructure-ports/ISearchProvider.js";
export type { IMediaMetadataProvider, MediaMetadata, MediaType } from "./infrastructure-ports/IMediaMetadataProvider.js";

export const DEFAULT_ACCOUNT_ID = "acct_default";
export const UNAUTHENTICATED_ACCOUNT_ID = "acct_unauthenticated";

export type TokenCredential = Record<string, unknown>;

export class UnauthenticatedAccountError extends Error {
  constructor(message = "未登录，请先登录后再操作。") {
    super(message);
    this.name = "UnauthenticatedAccountError";
  }
}
