import { describe, expect, it } from "vitest";
import { contextIsOwner } from "./owner-guard";

/**
 * 站长判定的四个反例必须都是 false——其中三个都对应真实会发生的误放行：
 *  1. **成员**：有 `storage:transfer` 但没有站长位 → 需求明确不允许。
 *  2. **带通配符的自定义角色**：`permissions` 含 `*`，`isMaster` 为 true，
 *     但它不是 `role_owner`。只查权限集合就会放行——这是权限收敛最大的漏点。
 *  3. **管理员**：有 `storage:browse_any`，仍不是站长。
 *  4. **API Key**：即便 key 的主人是站长，站长专属能力也不该经一枚可复制的
 *     bearer 令牌开放。
 */
describe("contextIsOwner（站长判定的唯一实现）", () => {
  const owner = { roleId: "role_owner", isMaster: true };
  const member = { roleId: "role_member", isMaster: false };
  const admin = { roleId: "role_admin", isMaster: false };
  const wildcardCustomRole = { roleId: "role_custom_x", isMaster: true };

  it("站长 → true（含单用户实例：role_owner + isMaster）", () => {
    expect(contextIsOwner(owner)).toBe(true);
  });

  it("成员 → false（成员有 storage:transfer，但那不是站长位）", () => {
    expect(contextIsOwner(member)).toBe(false);
  });

  it("管理员 → false（有 browse_any 也不算站长）", () => {
    expect(contextIsOwner(admin)).toBe(false);
  });

  it("**带通配符的自定义角色 → false**（只看 isMaster 会误放行）", () => {
    expect(contextIsOwner(wildcardCustomRole)).toBe(false);
  });

  it("**API Key → false**，即使角色是 role_owner", () => {
    expect(contextIsOwner({ ...owner, apiKeyId: "key_x" })).toBe(false);
  });
});
