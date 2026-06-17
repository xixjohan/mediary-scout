/**
 * Pure decision logic for §7 multi-account storage binding + category directory
 * provisioning. No I/O here — the Postgres repository (binding) and the real 115
 * storage adapter (dir provisioning) inject their effects. Keeping the rules pure
 * keeps the instance-wide uniqueness invariant and the idempotent find-or-create
 * testable without a database or a live 网盘.
 */

export interface ConnectedStorageRow {
  id: string;
  accountId: string;
  provider: string;
  providerUid: string;
}

export type StorageBindingDecision =
  | { action: "insert" }
  | { action: "refresh"; storageId: string }
  | { action: "reject"; ownerAccountId: string };

/**
 * Enforce instance-wide UNIQUE(provider, provider_uid):
 * - unseen (provider, uid)        → insert a new connection
 * - already owned by this account → refresh (re-scan updates the cookie payload)
 * - owned by another account      → reject (never let two accounts bind one 网盘)
 */
export function resolveStorageBinding(input: {
  provider: string;
  providerUid: string;
  accountId: string;
  existing: ConnectedStorageRow | null;
}): StorageBindingDecision {
  const { existing, accountId } = input;
  if (!existing) {
    return { action: "insert" };
  }
  if (existing.accountId === accountId) {
    return { action: "refresh", storageId: existing.id };
  }
  return { action: "reject", ownerAccountId: existing.accountId };
}

export interface DirProvisionStorage {
  listChildDirs(parentId: string): Promise<Array<{ name: string; id: string }>>;
  createDirectory(input: { name: string; parentId: string }): Promise<string>;
}

export interface ProvisionedCids {
  rootCid: string;
  moviesCid: string;
  tvCid: string;
  animeCid: string;
}

/**
 * Idempotent: reuse a same-named directory if one already exists under the
 * parent, else create it. Safe to re-run on an already-provisioned 网盘 (the
 * second run finds every dir and creates nothing).
 */
export async function provisionCategoryDirs(input: {
  storage: DirProvisionStorage;
  baseParentId: string;
  rootName?: string;
}): Promise<ProvisionedCids> {
  const rootName = input.rootName ?? "media-track";
  const findOrCreate = async (name: string, parentId: string): Promise<string> => {
    const existing = (await input.storage.listChildDirs(parentId)).find((dir) => dir.name === name);
    return existing ? existing.id : input.storage.createDirectory({ name, parentId });
  };
  const rootCid = await findOrCreate(rootName, input.baseParentId);
  const moviesCid = await findOrCreate("Movies", rootCid);
  const tvCid = await findOrCreate("TV", rootCid);
  const animeCid = await findOrCreate("Anime", rootCid);
  return { rootCid, moviesCid, tvCid, animeCid };
}
