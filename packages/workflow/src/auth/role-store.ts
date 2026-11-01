import {
  type RoleEntity,
  BUILTIN_ROLES,
  ROLE_LEVELS,
} from "@media-track/shared";
import type { WorkflowRepository } from "../persistence/repository.js";

const ROLES_SETTING_KEY = "system_roles_v1";

export interface CreateRoleInput {
  id?: string | undefined;
  name: string;
  description?: string | undefined;
  level?: number | undefined;
  permissions: string[];
}

export interface UpdateRoleInput {
  name?: string | undefined;
  description?: string | undefined;
  level?: number | undefined;
  permissions?: string[] | undefined;
}

export class RoleStore {
  private _cachedRoles: RoleEntity[] | null = null;
  private _cacheTimestamp = 0;
  private readonly _cacheTtlMs = 15_000; // 15秒只读内存缓存

  constructor(private readonly _repo: WorkflowRepository) {}

  public invalidateCache(): void {
    this._cachedRoles = null;
    this._cacheTimestamp = 0;
  }

  public async listRoles(): Promise<RoleEntity[]> {
    const now = Date.now();
    if (this._cachedRoles && now - this._cacheTimestamp < this._cacheTtlMs) {
      return [...this._cachedRoles];
    }

    const raw = await this._repo.getSetting(ROLES_SETTING_KEY);
    let roles: RoleEntity[] = [];

    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          roles = parsed;
        }
      } catch {
        roles = [];
      }
    }

    // 确保所有内置角色均存在（合并补齐，防止版本升级丢失新内置角色）
    const roleMap = new Map<string, RoleEntity>();
    for (const r of Object.values(BUILTIN_ROLES)) {
      roleMap.set(r.id, { ...r });
    }
    for (const r of roles) {
      roleMap.set(r.id, { ...r });
    }

    const merged = Array.from(roleMap.values()).sort((a, b) => a.level - b.level);
    this._cachedRoles = merged;
    this._cacheTimestamp = now;
    return merged;
  }

  public async getRole(id: string): Promise<RoleEntity | null> {
    const roles = await this.listRoles();
    return roles.find((r) => r.id === id) || null;
  }

  public async getPermissionsForRole(roleId: string): Promise<string[]> {
    const role = await this.getRole(roleId);
    return role ? [...role.permissions] : [];
  }

  public async createRole(input: CreateRoleInput): Promise<RoleEntity> {
    const roles = await this.listRoles();
    const id = input.id?.trim() || `role_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    
    if (roles.some((r) => r.id === id)) {
      throw new Error(`角色 ID [${id}] 已存在`);
    }

    // 自定义角色等级不可小于或等于 OWNER (10)，防止通过新建角色自提权
    const level = typeof input.level === "number" && input.level > ROLE_LEVELS.OWNER
      ? input.level
      : ROLE_LEVELS.MEMBER;

    const now = Date.now();
    const entity: RoleEntity = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() || "",
      level,
      isSystem: false,
      permissions: [...input.permissions],
      createdAt: now,
      updatedAt: now,
    };

    roles.push(entity);
    await this._repo.setSetting(ROLES_SETTING_KEY, JSON.stringify(roles));
    this.invalidateCache();
    return entity;
  }

  public async updateRole(id: string, input: UpdateRoleInput): Promise<RoleEntity> {
    const roles = await this.listRoles();
    const target = roles.find((r) => r.id === id);
    if (!target) {
      throw new Error(`角色 [${id}] 不存在`);
    }

    if (input.name !== undefined) {
      target.name = input.name.trim();
    }
    if (input.description !== undefined) {
      target.description = input.description.trim();
    }
    if (input.permissions !== undefined) {
      // 站长角色永远保留通配符
      target.permissions = id === "role_owner"
        ? Array.from(new Set(["*", ...input.permissions]))
        : [...input.permissions];
    }
    if (input.level !== undefined && !target.isSystem) {
      target.level = Math.max(ROLE_LEVELS.ADMIN, input.level);
    }

    target.updatedAt = Date.now();
    await this._repo.setSetting(ROLES_SETTING_KEY, JSON.stringify(roles));
    this.invalidateCache();
    return target;
  }

  public async deleteRole(id: string): Promise<boolean> {
    const roles = await this.listRoles();
    const target = roles.find((r) => r.id === id);
    if (!target) return false;

    if (target.isSystem) {
      throw new Error(`内置系统角色 [${target.name}] 不允许被删除`);
    }

    const filtered = roles.filter((r) => r.id !== id);
    await this._repo.setSetting(ROLES_SETTING_KEY, JSON.stringify(filtered));
    this.invalidateCache();
    return true;
  }
}
