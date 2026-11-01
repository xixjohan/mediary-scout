import { DEFAULT_ACCOUNT_ID } from "./domain.js";

export type MultiUserMode = "off" | "isolated" | "shared";

export function getMultiUserMode(): MultiUserMode {
  if (process.env.MEDIA_TRACK_MULTI_USER !== "1") {
    return "off";
  }
  const mode = process.env.MEDIA_TRACK_MULTI_USER_MODE?.trim().toLowerCase();
  if (mode === "shared") {
    return "shared";
  }
  return "isolated";
}

export function isSharedResourceMode(): boolean {
  return getMultiUserMode() === "shared";
}

export interface StorageScopeContext {
  requestAccountId: string;
  explicitStorageId?: string | null;
}

export interface ResolvedMediaScope {
  targetAccountId: string;
  targetStorageId: string | null;
}

export interface IStorageScopeStrategy {
  readonly mode: MultiUserMode;
  resolveMediaScope(context: StorageScopeContext): Promise<ResolvedMediaScope>;
  canManageStorage(accountId: string, isOwner: boolean): boolean;
  canDeleteMedia(accountId: string, isOwner: boolean): boolean;
}

export class SingleUserStorageStrategy implements IStorageScopeStrategy {
  readonly mode = "off" as const;

  async resolveMediaScope(context: StorageScopeContext): Promise<ResolvedMediaScope> {
    return {
      targetAccountId: DEFAULT_ACCOUNT_ID,
      targetStorageId: context.explicitStorageId ?? null,
    };
  }

  canManageStorage(): boolean {
    return true;
  }

  canDeleteMedia(): boolean {
    return true;
  }
}

export class IsolatedTenantStorageStrategy implements IStorageScopeStrategy {
  readonly mode = "isolated" as const;

  async resolveMediaScope(context: StorageScopeContext): Promise<ResolvedMediaScope> {
    return {
      targetAccountId: context.requestAccountId,
      targetStorageId: context.explicitStorageId ?? null,
    };
  }

  canManageStorage(): boolean {
    return true;
  }

  canDeleteMedia(): boolean {
    return true;
  }
}

export class SharedPoolStorageStrategy implements IStorageScopeStrategy {
  readonly mode = "shared" as const;

  constructor(private readonly sharedHostAccountId: string = DEFAULT_ACCOUNT_ID) {}

  async resolveMediaScope(context: StorageScopeContext): Promise<ResolvedMediaScope> {
    return {
      targetAccountId: this.sharedHostAccountId,
      targetStorageId: context.explicitStorageId ?? null,
    };
  }

  canManageStorage(_accountId: string, isOwner: boolean): boolean {
    return isOwner;
  }

  canDeleteMedia(_accountId: string, isOwner: boolean): boolean {
    return isOwner;
  }
}

export function createStorageScopeStrategy(mode = getMultiUserMode()): IStorageScopeStrategy {
  switch (mode) {
    case "shared":
      return new SharedPoolStorageStrategy();
    case "isolated":
      return new IsolatedTenantStorageStrategy();
    case "off":
    default:
      return new SingleUserStorageStrategy();
  }
}
