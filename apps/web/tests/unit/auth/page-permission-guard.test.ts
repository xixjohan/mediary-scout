import { describe, expect, it } from "vitest";
import {
  decidePageAccess,
  hasPermission,
  type PageAccess,
} from "../../../platform/next-context/page-permission-guard";
import {
  NAV_ALL_VISIBLE,
  resolveVisibilityFromPermissions,
} from "../../../features/auth/core/nav-visibility";

/**
 * 页面授权判定。
 *
 * 这里测的是**分支**，不是接线：页面是否真的调用了这个纯函数由各 page.tsx 的
 * 结构保证（`if (verdict !== "allow") return <PageAccessDenied/>`）。
 * 关键红线有三条：单用户/站长全放行、成员被挡、未登录走 login 而不是 deny。
 */

const owner: PageAccess = { authenticated: true, isOwner: true, permissions: new Set(["*"]) };
const member: PageAccess = {
  authenticated: true,
  isOwner: false,
  permissions: new Set([
    "media:search",
    "media:detail",
    "media:play",
    "media:subscribe",
    "notifications:read",
    "storage:list",
    "storage:transfer",
    "workflow:status",
  ]),
};
const anonymous: PageAccess = { authenticated: false, isOwner: false, permissions: new Set() };

describe("decidePageAccess", () => {
  it("未登录先判登录态，而不是判权限（否则用户会被误导成「权限不足」）", () => {
    expect(decidePageAccess(anonymous, "system:settings")).toBe("login");
    expect(decidePageAccess(anonymous, "media:search")).toBe("login");
  });

  it("站长（含单用户隐式站长）无条件放行", () => {
    expect(decidePageAccess(owner, "system:settings")).toBe("allow");
    expect(decidePageAccess(owner, "storage:browse_any")).toBe("allow");
    expect(decidePageAccess(owner, "library:manage")).toBe("allow");
    // 通配符同样视为放行，防止自定义角色误配成 ["*"] 后被挡。
    expect(decidePageAccess({ authenticated: true, isOwner: false, permissions: new Set(["*"]) }, "system:settings")).toBe("allow");
  });

  it("成员被设置页/网盘页/STRM 页挡住", () => {
    expect(decidePageAccess(member, "system:settings")).toBe("deny");
    expect(decidePageAccess(member, "storage:browse_any")).toBe("deny");
    expect(decidePageAccess(member, "library:manage")).toBe("deny");
  });

  it("成员可以看影视库内容（决策 1：只禁管理面）", () => {
    expect(hasPermission(member, "media:detail")).toBe(true);
    expect(hasPermission(member, "storage:list")).toBe(true);
    // 但管理面不行
    expect(hasPermission(member, "library:manage")).toBe(false);
  });
});

describe("侧边栏可见性（UX 层，不是安全边界）", () => {
  it("站长全部可见", () => {
    expect(resolveVisibilityFromPermissions(owner.permissions)).toEqual(NAV_ALL_VISIBLE);
  });

  it("成员看不到网盘、设置、助理，但保留影视库与通知/活动入口", () => {
    expect(resolveVisibilityFromPermissions(member.permissions)).toEqual({
      storage: false,
      medialib: true,
      chat: false,
      settings: false,
    });
  });

  it("骨架屏默认全可见——骨架不知道角色，不能据此隐藏入口", () => {
    expect(NAV_ALL_VISIBLE).toEqual({ storage: true, medialib: true, chat: true, settings: true });
  });
});
