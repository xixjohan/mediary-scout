import {
  type ApiKeyV2Entity,
  generateApiKeyV2,
  hashApiKeyV2,
  verifyApiKeyV2Hash,
  validateDelegationBoundary,
} from "@media-track/shared";
import type { WorkflowRepository } from "../persistence/repository.js";

const API_KEYS_V2_SETTING_KEY = "api_keys_v2";

export interface CreateApiKeyV2Input {
  name: string;
  permissions: string[];
  allowApi?: boolean | undefined;
  allowMcp?: boolean | undefined;
  expiresAt?: number | null | undefined;
  userId?: string | undefined;
  ownerSecurityVersion?: number | undefined;
}

export class ApiKeyV2Store {
  // 高性能前缀内存索引缓存 (TTL 30 秒)
  private readonly _prefixCache = new Map<string, { entity: ApiKeyV2Entity; cachedAt: number }>();
  private readonly _cacheTtlMs = 30_000;

  constructor(private readonly _repo: WorkflowRepository) {}

  public invalidateMemoryCache(): void {
    this._prefixCache.clear();
  }

  public async listKeys(): Promise<ApiKeyV2Entity[]> {
    const raw = await this._repo.getSetting(API_KEYS_V2_SETTING_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  public async getKey(id: string): Promise<ApiKeyV2Entity | null> {
    const keys = await this.listKeys();
    return keys.find((k) => k.id === id) || null;
  }

  public async createKey(
    input: CreateApiKeyV2Input,
    creatorPermissions?: string[],
  ): Promise<{
    entity: ApiKeyV2Entity;
    plainTextKey: string;
  }> {
    // 校验定理一：子集不变性定理 (防提权委托边界)
    if (creatorPermissions) {
      const boundaryCheck = validateDelegationBoundary(creatorPermissions, input.permissions);
      if (!boundaryCheck.allowed) {
        throw new Error(
          `权限越界：您的角色无权为 API Key 分配未拥有的功能权限 [${boundaryCheck.violations.join(", ")}]`
        );
      }
    }

    const { key, keyHash, keyPrefix, maskedKey } = generateApiKeyV2();
    const id = `key_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const entity: ApiKeyV2Entity = {
      id,
      name: input.name.trim(),
      keyHash,
      keyPrefix,
      maskedKey,
      permissions: [...input.permissions],
      allowApi: input.allowApi !== false,
      allowMcp: input.allowMcp !== false,
      createdAt: Date.now(),
      expiresAt: input.expiresAt ?? null,
      lastUsedAt: null,
      revokedAt: null,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.ownerSecurityVersion !== undefined
        ? { ownerSecurityVersion: input.ownerSecurityVersion }
        : { ownerSecurityVersion: 1 }),
    };

    const keys = await this.listKeys();
    keys.push(entity);
    await this._repo.setSetting(API_KEYS_V2_SETTING_KEY, JSON.stringify(keys));

    this.invalidateMemoryCache();
    return {
      entity,
      plainTextKey: key,
    };
  }

  public async revokeKey(id: string): Promise<boolean> {
    const keys = await this.listKeys();
    const target = keys.find((k) => k.id === id);
    if (!target) return false;

    target.revokedAt = Date.now();
    await this._repo.setSetting(API_KEYS_V2_SETTING_KEY, JSON.stringify(keys));
    this.invalidateMemoryCache();
    return true;
  }

  public async deleteKey(id: string): Promise<boolean> {
    const keys = await this.listKeys();
    const filtered = keys.filter((k) => k.id !== id);
    if (filtered.length !== keys.length) {
      await this._repo.setSetting(API_KEYS_V2_SETTING_KEY, JSON.stringify(filtered));
      this.invalidateMemoryCache();
      return true;
    }
    return false;
  }

  public async touchLastUsed(id: string): Promise<void> {
    const keys = await this.listKeys();
    const target = keys.find((k) => k.id === id);
    if (!target) return;
    target.lastUsedAt = Date.now();
    await this._repo.setSetting(API_KEYS_V2_SETTING_KEY, JSON.stringify(keys));
  }

  public async batchTouchLastUsed(
    touches: Array<{ id: string; timestamp: number }>,
  ): Promise<void> {
    if (!touches || touches.length === 0) return;
    const keys = await this.listKeys();
    const touchMap = new Map<string, number>();
    for (const t of touches) {
      touchMap.set(t.id, Math.max(touchMap.get(t.id) || 0, t.timestamp));
    }

    let modified = false;
    for (const key of keys) {
      const ts = touchMap.get(key.id);
      if (ts !== undefined) {
        key.lastUsedAt = ts;
        modified = true;
      }
    }

    if (modified) {
      await this._repo.setSetting(API_KEYS_V2_SETTING_KEY, JSON.stringify(keys));
    }
  }

  private _checkFastPath(cleanToken: string, now: number): ApiKeyV2Entity | null {
    if (!cleanToken.startsWith("msk_live_") || cleanToken.length < 12) return null;
    const prefix = cleanToken.slice(0, 12);
    const cached = this._prefixCache.get(prefix);
    if (!cached || now - cached.cachedAt >= this._cacheTtlMs) return null;

    const ent = cached.entity;
    const isValid = ent.revokedAt === null && (ent.expiresAt === null || ent.expiresAt > now);
    if (isValid && verifyApiKeyV2Hash(cleanToken, ent.keyHash)) {
      return ent;
    }
    return null;
  }

  private _scanKeyList(cleanToken: string, now: number, keys: ApiKeyV2Entity[]): ApiKeyV2Entity | null {
    for (const keyEntity of keys) {
      if (keyEntity.revokedAt !== null) continue;
      if (keyEntity.expiresAt !== null && keyEntity.expiresAt <= now) continue;

      if (verifyApiKeyV2Hash(cleanToken, keyEntity.keyHash)) {
        if (keyEntity.keyPrefix) {
          this._prefixCache.set(keyEntity.keyPrefix, { entity: keyEntity, cachedAt: now });
        }
        return keyEntity;
      }
    }
    return null;
  }

  private async _checkLegacyKey(cleanToken: string): Promise<ApiKeyV2Entity | null> {
    const legacyKey = await this._repo.getSetting("api_key");
    if (!legacyKey || !legacyKey.trim() || cleanToken !== legacyKey.trim()) {
      return null;
    }
    return {
      id: "legacy_root_key",
      name: "Legacy Single API Key",
      keyHash: hashApiKeyV2(legacyKey.trim()),
      keyPrefix: "legacy",
      maskedKey: "legacy-root-key",
      permissions: ["*"],
      createdAt: 0,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
  }

  /**
   * 通过明文 Token 高速比对 API Key (支持 Fast-Path 内存索引与版本比对)
   */
  public async findKeyByPlainToken(plainText: string): Promise<ApiKeyV2Entity | null> {
    if (!plainText || typeof plainText !== "string") return null;
    const cleanToken = plainText.trim();
    if (!cleanToken) return null;

    const now = Date.now();
    const fastHit = this._checkFastPath(cleanToken, now);
    if (fastHit) return fastHit;

    const keys = await this.listKeys();
    const scannedHit = this._scanKeyList(cleanToken, now, keys);
    if (scannedHit) return scannedHit;

    return this._checkLegacyKey(cleanToken);
  }
}
