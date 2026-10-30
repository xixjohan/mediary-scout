/**
 * Executor construction moved into the brand registry itself (storage-brands.ts),
 * so `create` sits next to the brand's other capabilities and adding a drive is
 * adding one entry. This module re-exports for the existing import sites and the
 * public barrel; see storage-registry.test.ts for the invariant tests.
 */
export {
  buildExecutorForBrand,
  createExecutorForBrand,
  type StorageDriverCreateInput,
} from "./storage-brands.js";
