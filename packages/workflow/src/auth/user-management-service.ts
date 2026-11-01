import { randomBytes } from "node:crypto";
import {
  ROLE_LEVELS,
  type RoleEntity,
  canManageUser,
  canGrantRole,
} from "@media-track/shared";
import type { WorkflowRepository } from "../persistence/repository.js";
import type { Account } from "../storage/account-credentials.js";
import { RoleStore } from "./role-store.js";
import { hashPassword } from "./password.js";

const ACCOUNT_ROLE_SETTING_PREFIX = "acct_role_";
const ACCOUNT_SECURITY_VERSION_PREFIX = "acct_secver_";
const ACCOUNT_ACTIVE_SETTING_PREFIX = "acct_active_";

export interface ManagedUserView {
  id: string;
  username: string;
  isOwner: boolean;
  roleId: string;
  roleName: string;
  roleLevel: number;
  securityVersion: number;
  isActive: boolean;
  createdAt: string;
}

export class UserManagementService {
  private readonly _roleStore: RoleStore;

  constructor(private readonly _repo: WorkflowRepository) {
    this._roleStore = new RoleStore(this._repo);
  }

  public getRoleStore(): RoleStore {
    return this._roleStore;
  }

  public async getUserRole(accountId: string, isOwnerFallback = false): Promise<RoleEntity> {
    const customRoleId = await this._repo.getAccountSetting(accountId, "role_id");
    const roleId = customRoleId?.trim() || (isOwnerFallback ? "role_owner" : "role_member");
    const role = await this._roleStore.getRole(roleId);
    if (role) return role;

    // 找不到指定角色时安全降级为内置成员角色
    return (await this._roleStore.getRole(isOwnerFallback ? "role_owner" : "role_member"))!;
  }

  public async getUserSecurityVersion(accountId: string): Promise<number> {
    const raw = await this._repo.getAccountSetting(accountId, "security_version");
    if (!raw) return 1;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  public async bumpUserSecurityVersion(accountId: string): Promise<number> {
    const current = await this.getUserSecurityVersion(accountId);
    const next = current + 1;
    await this._repo.setAccountSetting(accountId, "security_version", String(next));
    return next;
  }

  public async isUserActive(accountId: string, isOwnerFallback = false): Promise<boolean> {
    if (isOwnerFallback) return true; // 站长永远不可被停用
    const raw = await this._repo.getAccountSetting(accountId, "is_active");
    if (!raw) return true;
    return raw !== "0" && raw !== "false";
  }

  public async getUserPermissions(accountId: string, isOwnerFallback = false): Promise<string[]> {
    const role = await this.getUserRole(accountId, isOwnerFallback);
    return [...role.permissions];
  }

  public async listManagedUsers(): Promise<ManagedUserView[]> {
    const accounts = await this._repo.listAccounts();
    const roles = await this._roleStore.listRoles();
    const roleMap = new Map<string, RoleEntity>(roles.map((r) => [r.id, r]));

    const results: ManagedUserView[] = [];
    for (const acc of accounts) {
      const customRoleId = await this._repo.getAccountSetting(acc.id, "role_id");
      const roleId = customRoleId?.trim() || (acc.isOwner ? "role_owner" : "role_member");
      const role = roleMap.get(roleId) || roleMap.get(acc.isOwner ? "role_owner" : "role_member")!;

      const securityVersion = await this.getUserSecurityVersion(acc.id);
      const isActive = await this.isUserActive(acc.id, acc.isOwner);

      results.push({
        id: acc.id,
        username: acc.username,
        isOwner: acc.isOwner,
        roleId: role.id,
        roleName: role.name,
        roleLevel: role.level,
        securityVersion,
        isActive,
        createdAt: acc.createdAt,
      });
    }

    return results;
  }

  public async setUserRole(
    actorAccountId: string,
    targetAccountId: string,
    newRoleId: string,
  ): Promise<void> {
    const actor = await this._repo.getAccountById(actorAccountId);
    const target = await this._repo.getAccountById(targetAccountId);
    if (!actor || !target) {
      throw new Error("操作者或目标用户不存在");
    }

    const actorRole = await this.getUserRole(actor.id, actor.isOwner);
    const targetRole = await this.getUserRole(target.id, target.isOwner);
    const targetNewRole = await this._roleStore.getRole(newRoleId);
    if (!targetNewRole) {
      throw new Error(`目标角色 [${newRoleId}] 不存在`);
    }

    // 校验定理二：管理越级免疫定理 (上级管下级，同级不互斥)
    if (!canManageUser(actorRole.level, targetRole.level)) {
      throw new Error("权限不足：您无权管理同级或更高权限的用户");
    }

    // 校验赋权边界：不能赋予高于或等于自身的角色
    if (!canGrantRole(actorRole.level, targetNewRole.level)) {
      throw new Error("权限不足：您无法分发高于或等于自身等级的角色");
    }

    // 禁止降权最后一个站长
    if (target.isOwner && newRoleId !== "role_owner") {
      const allAccounts = await this._repo.listAccounts();
      const owners = allAccounts.filter((a) => a.isOwner);
      if (owners.length <= 1) {
        throw new Error("保护限制：系统必须保留至少一位站长所有者");
      }
    }

    await this._repo.setAccountSetting(target.id, "role_id", newRoleId);
    // 联动定理三：自增安全版本号，让旧的特权 API Key 瞬间级联失效
    await this.bumpUserSecurityVersion(target.id);
  }

  public async setUserActive(
    actorAccountId: string,
    targetAccountId: string,
    isActive: boolean,
  ): Promise<void> {
    const actor = await this._repo.getAccountById(actorAccountId);
    const target = await this._repo.getAccountById(targetAccountId);
    if (!actor || !target) {
      throw new Error("操作者或目标用户不存在");
    }

    if (target.isOwner) {
      throw new Error("保护限制：系统所有者账号不可被停用");
    }

    const actorRole = await this.getUserRole(actor.id, actor.isOwner);
    const targetRole = await this.getUserRole(target.id, target.isOwner);
    if (!canManageUser(actorRole.level, targetRole.level)) {
      throw new Error("权限不足：您无权操作该用户");
    }

    await this._repo.setAccountSetting(target.id, "is_active", isActive ? "1" : "0");
    await this.bumpUserSecurityVersion(target.id);
    if (!isActive) {
      // 停用时一并清空其所有登录 Session
      await this._repo.deleteSessionsForAccount(target.id);
    }
  }

  public async resetUserPassword(
    actorAccountId: string,
    targetAccountId: string,
    newPlainPassword: string,
  ): Promise<void> {
    if (newPlainPassword.length < 6) {
      throw new Error("新密码至少 6 位");
    }

    const actor = await this._repo.getAccountById(actorAccountId);
    const target = await this._repo.getAccountById(targetAccountId);
    if (!actor || !target) {
      throw new Error("操作者或目标用户不存在");
    }

    const actorRole = await this.getUserRole(actor.id, actor.isOwner);
    const targetRole = await this.getUserRole(target.id, target.isOwner);

    // 自己修改自己密码，或者上级管理下级
    if (actor.id !== target.id && !canManageUser(actorRole.level, targetRole.level)) {
      throw new Error("权限不足：您无权重置该用户的密码");
    }

    const hash = await hashPassword(newPlainPassword);
    await this._repo.setAccountPassword(target.id, hash);
    await this._repo.deleteSessionsForAccount(target.id);
    await this.bumpUserSecurityVersion(target.id);
  }

  public async createManagedUser(
    actorAccountId: string,
    input: {
      username: string;
      password: string;
      roleId?: string;
    },
  ): Promise<ManagedUserView> {
    const trimmedUsername = input.username?.trim() ?? "";
    if (trimmedUsername.length < 2) {
      throw new Error("用户名至少 2 个字符");
    }
    if (!input.password || input.password.length < 6) {
      throw new Error("密码至少 6 位");
    }

    const actor = await this._repo.getAccountById(actorAccountId);
    if (!actor) {
      throw new Error("操作者账号不存在");
    }
    const actorRole = await this.getUserRole(actor.id, actor.isOwner);

    // 仅 Admin 及以上等级允许创建用户 (level <= 20)
    if (!actor.isOwner && actorRole.level > 20) {
      throw new Error("权限不足：仅管理员可创建新用户");
    }

    const targetRoleId = input.roleId?.trim() || "role_member";
    const targetRole = await this._roleStore.getRole(targetRoleId);
    if (!targetRole) {
      throw new Error(`目标角色 [${targetRoleId}] 不存在`);
    }

    if (!canGrantRole(actorRole.level, targetRole.level)) {
      throw new Error("权限不足：您无法分发高于或等于自身等级的角色");
    }

    const existing = await this._repo.getAccountByUsername(trimmedUsername);
    if (existing) {
      throw new Error(`用户名「${trimmedUsername}」已被占用`);
    }

    const passwordHash = await hashPassword(input.password);
    const id = `acct_${randomBytes(12).toString("hex")}`;
    const now = new Date().toISOString();

    const newAccount: Account = {
      id,
      username: trimmedUsername,
      passwordHash,
      groupId: null,
      isOwner: false,
      createdAt: now,
    };

    await this._repo.createAccount(newAccount);
    await this._repo.setAccountSetting(id, "role_id", targetRoleId);
    await this._repo.setAccountSetting(id, "security_version", "1");
    await this._repo.setAccountSetting(id, "is_active", "1");

    return {
      id,
      username: trimmedUsername,
      isOwner: false,
      roleId: targetRole.id,
      roleName: targetRole.name,
      roleLevel: targetRole.level,
      securityVersion: 1,
      isActive: true,
      createdAt: now,
    };
  }
}
