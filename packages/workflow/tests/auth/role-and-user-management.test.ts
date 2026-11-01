import { describe, expect, it } from "vitest";
import {
  InMemoryWorkflowRepository,
  RoleStore,
  UserManagementService,
  ApiKeyV2Store,
  type Account,
} from "../../src/index.js";
import { BUILTIN_ROLES, ROLE_LEVELS } from "@media-track/shared";

function makeAccount(id: string, username: string, isOwner = false): Account {
  return {
    id,
    username,
    passwordHash: "scrypt:aa:bb",
    groupId: null,
    isOwner,
    createdAt: new Date().toISOString(),
  };
}

describe("RoleStore & RBAC Module Management", () => {
  it("initializes with default builtin roles", async () => {
    const repo = new InMemoryWorkflowRepository();
    const roleStore = new RoleStore(repo);

    const roles = await roleStore.listRoles();
    expect(roles.length).toBeGreaterThanOrEqual(5);

    const owner = roles.find((r) => r.id === "role_owner");
    const member = roles.find((r) => r.id === "role_member");
    expect(owner).toBeDefined();
    expect(owner?.level).toBe(ROLE_LEVELS.OWNER);
    expect(member).toBeDefined();
    expect(member?.level).toBe(ROLE_LEVELS.MEMBER);
  });

  it("creates custom role and allows editing permissions", async () => {
    const repo = new InMemoryWorkflowRepository();
    const roleStore = new RoleStore(repo);

    const created = await roleStore.createRole({
      name: "影音归档专员",
      description: "负责整理网盘剧集",
      level: 45,
      permissions: ["media:search", "storage:list", "storage:organize"],
    });

    expect(created.id.startsWith("role_")).toBe(true);
    expect(created.isSystem).toBe(false);

    // Update permissions
    const updated = await roleStore.updateRole(created.id, {
      permissions: ["media:search", "storage:list"],
    });
    expect(updated.permissions).toEqual(["media:search", "storage:list"]);

    // Fetch by id
    const found = await roleStore.getRole(created.id);
    expect(found?.permissions).toEqual(["media:search", "storage:list"]);
  });

  it("prevents deleting builtin system roles", async () => {
    const repo = new InMemoryWorkflowRepository();
    const roleStore = new RoleStore(repo);

    await expect(roleStore.deleteRole("role_owner")).rejects.toThrow("内置系统角色");
    await expect(roleStore.deleteRole("role_member")).rejects.toThrow("内置系统角色");
  });
});

describe("UserManagementService & Security Version Governance", () => {
  it("lists managed users and defaults owner to role_owner, member to role_member", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.createAccount(makeAccount("acct_owner", "owner_bob", true));
    await repo.createAccount(makeAccount("acct_alice", "alice", false));

    const userSvc = new UserManagementService(repo);
    const users = await userSvc.listManagedUsers();

    expect(users).toHaveLength(2);
    const bob = users.find((u) => u.username === "owner_bob");
    const alice = users.find((u) => u.username === "alice");

    expect(bob?.roleId).toBe("role_owner");
    expect(bob?.roleLevel).toBe(ROLE_LEVELS.OWNER);
    expect(bob?.securityVersion).toBe(1);

    expect(alice?.roleId).toBe("role_member");
    expect(alice?.roleLevel).toBe(ROLE_LEVELS.MEMBER);
    expect(alice?.securityVersion).toBe(1);
  });

  it("enforces management boundary and bumps security_version on role change", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.createAccount(makeAccount("acct_owner", "boss", true));
    await repo.createAccount(makeAccount("acct_admin", "manager", false));
    await repo.createAccount(makeAccount("acct_user", "worker", false));

    const userSvc = new UserManagementService(repo);

    // Owner sets acct_admin to role_admin
    await userSvc.setUserRole("acct_owner", "acct_admin", "role_admin");
    const adminUser = (await userSvc.listManagedUsers()).find((u) => u.id === "acct_admin");
    expect(adminUser?.roleId).toBe("role_admin");
    expect(adminUser?.securityVersion).toBe(2); // Bumped!

    // Admin can manage worker to Guest
    await userSvc.setUserRole("acct_admin", "acct_user", "role_guest");
    const workerUser = (await userSvc.listManagedUsers()).find((u) => u.id === "acct_user");
    expect(workerUser?.roleId).toBe("role_guest");
    expect(workerUser?.securityVersion).toBe(2);

    // Admin CANNOT manage Owner (peer or higher)
    await expect(
      userSvc.setUserRole("acct_admin", "acct_owner", "role_guest"),
    ).rejects.toThrow("权限不足");

    // Admin CANNOT grant role_owner or role_admin
    await expect(
      userSvc.setUserRole("acct_admin", "acct_user", "role_admin"),
    ).rejects.toThrow("权限不足");
  });

  it("prevents deactivating or removing the last Owner", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.createAccount(makeAccount("acct_owner", "boss", true));

    const userSvc = new UserManagementService(repo);
    await expect(
      userSvc.setUserActive("acct_owner", "acct_owner", false),
    ).rejects.toThrow("系统所有者账号不可被停用");

    await expect(
      userSvc.setUserRole("acct_owner", "acct_owner", "role_member"),
    ).rejects.toThrow("系统必须保留至少一位站长所有者");
  });

  it("allows owner to create a new managed user with role", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.createAccount(makeAccount("acct_owner", "boss", true));

    const userSvc = new UserManagementService(repo);
    const created = await userSvc.createManagedUser("acct_owner", {
      username: "carol",
      password: "SecretPassword123!",
      roleId: "role_member",
    });

    expect(created.id.startsWith("acct_")).toBe(true);
    expect(created.username).toBe("carol");
    expect(created.roleId).toBe("role_member");
    expect(created.isActive).toBe(true);

    const users = await userSvc.listManagedUsers();
    expect(users).toHaveLength(2);
    expect(users.some((u) => u.username === "carol")).toBe(true);
  });

  it("rejects creating user with duplicate username or weak password", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.createAccount(makeAccount("acct_owner", "boss", true));

    const userSvc = new UserManagementService(repo);
    await userSvc.createManagedUser("acct_owner", {
      username: "david",
      password: "Password123",
    });

    // Duplicate
    await expect(
      userSvc.createManagedUser("acct_owner", {
        username: "david",
        password: "OtherPassword123",
      }),
    ).rejects.toThrow("已被占用");

    // Weak password
    await expect(
      userSvc.createManagedUser("acct_owner", {
        username: "eve",
        password: "123",
      }),
    ).rejects.toThrow("至少 6 位");
  });

  it("strictly forbids member from creating new users", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.createAccount(makeAccount("acct_owner", "boss", true));
    await repo.createAccount(makeAccount("acct_member", "normal_user", false));

    const userSvc = new UserManagementService(repo);
    await expect(
      userSvc.createManagedUser("acct_member", {
        username: "hacker",
        password: "Password123",
      }),
    ).rejects.toThrow("权限不足");
  });
});

describe("ApiKeyV2Store Delegation Boundary & Fast-Path Cache", () => {
  it("allows creating key within creator's role permissions", async () => {
    const repo = new InMemoryWorkflowRepository();
    const keyStore = new ApiKeyV2Store(repo);

    const memberPermissions = BUILTIN_ROLES.role_member.permissions; // has media:search, storage:list, etc.

    const result = await keyStore.createKey(
      {
        name: "My Member Agent",
        permissions: ["media:search", "storage:list"],
        userId: "acct_member",
        ownerSecurityVersion: 1,
      },
      memberPermissions,
    );

    expect(result.entity.id.startsWith("key_")).toBe(true);
    expect(result.entity.permissions).toEqual(["media:search", "storage:list"]);
    expect(result.plainTextKey.startsWith("msk_live_")).toBe(true);

    // Fast path token verification
    const verified = await keyStore.findKeyByPlainToken(result.plainTextKey);
    expect(verified?.id).toBe(result.entity.id);
  });

  it("strictly rejects creating key with permissions outside creator's role (anti-privilege escalation)", async () => {
    const repo = new InMemoryWorkflowRepository();
    const keyStore = new ApiKeyV2Store(repo);

    const guestPermissions = BUILTIN_ROLES.role_guest.permissions; // only media:search, media:detail, system:health

    await expect(
      keyStore.createKey(
        {
          name: "Malicious Key Attempt",
          permissions: ["media:search", "storage:delete"], // storage:delete not allowed for guest
          userId: "acct_guest",
        },
        guestPermissions,
      ),
    ).rejects.toThrow("权限越界");
  });
});
