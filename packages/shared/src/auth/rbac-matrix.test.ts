import { describe, expect, it } from "vitest";
import {
  BUILTIN_ROLES,
  ROLE_LEVELS,
  calculateEffectivePermissions,
  canGrantRole,
  canManageUser,
  validateDelegationBoundary,
} from "./rbac-matrix.js";

describe("RBAC Matrix & Delegation Security", () => {
  it("defines standard builtin roles with descending permission hierarchy", () => {
    expect(BUILTIN_ROLES.role_owner.level).toBe(ROLE_LEVELS.OWNER);
    expect(BUILTIN_ROLES.role_admin.level).toBe(ROLE_LEVELS.ADMIN);
    expect(BUILTIN_ROLES.role_member.level).toBe(ROLE_LEVELS.MEMBER);
    expect(BUILTIN_ROLES.role_bot.level).toBe(ROLE_LEVELS.BOT);
    expect(BUILTIN_ROLES.role_guest.level).toBe(ROLE_LEVELS.GUEST);

    expect(BUILTIN_ROLES.role_owner.level).toBeLessThan(BUILTIN_ROLES.role_admin.level);
    expect(BUILTIN_ROLES.role_admin.level).toBeLessThan(BUILTIN_ROLES.role_member.level);
    expect(BUILTIN_ROLES.role_member.level).toBeLessThan(BUILTIN_ROLES.role_bot.level);
    expect(BUILTIN_ROLES.role_bot.level).toBeLessThan(BUILTIN_ROLES.role_guest.level);
  });

  describe("validateDelegationBoundary (Subset Invariance Theorem)", () => {
    it("allows Owner with wildcard to grant any requested permission", () => {
      const result = validateDelegationBoundary(["*"], ["media:search", "storage:delete"]);
      expect(result.allowed).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it("allows member to grant permissions within its own role boundary", () => {
      const memberPerms = BUILTIN_ROLES.role_member.permissions;
      const result = validateDelegationBoundary(memberPerms, ["media:search", "storage:list"]);
      expect(result.allowed).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it("rejects when member tries to grant permissions outside its role (anti-privilege escalation)", () => {
      const memberPerms = BUILTIN_ROLES.role_member.permissions; // Does NOT have storage:delete
      const result = validateDelegationBoundary(memberPerms, ["media:search", "storage:delete"]);
      expect(result.allowed).toBe(false);
      expect(result.violations).toEqual(["storage:delete"]);
    });
  });

  describe("Hierarchical user and role management governance", () => {
    it("allows Owner to manage anyone and grant any role", () => {
      expect(canManageUser(ROLE_LEVELS.OWNER, ROLE_LEVELS.ADMIN)).toBe(true);
      expect(canManageUser(ROLE_LEVELS.OWNER, ROLE_LEVELS.MEMBER)).toBe(true);
      expect(canGrantRole(ROLE_LEVELS.OWNER, ROLE_LEVELS.ADMIN)).toBe(true);
      expect(canGrantRole(ROLE_LEVELS.OWNER, ROLE_LEVELS.OWNER)).toBe(true);
    });

    it("allows Admin to manage Member and Guest but not peer Admin or Owner", () => {
      expect(canManageUser(ROLE_LEVELS.ADMIN, ROLE_LEVELS.MEMBER)).toBe(true);
      expect(canManageUser(ROLE_LEVELS.ADMIN, ROLE_LEVELS.GUEST)).toBe(true);

      // Cannot manage peer or higher
      expect(canManageUser(ROLE_LEVELS.ADMIN, ROLE_LEVELS.ADMIN)).toBe(false);
      expect(canManageUser(ROLE_LEVELS.ADMIN, ROLE_LEVELS.OWNER)).toBe(false);
    });

    it("allows Admin to grant Member or Guest role but prevents granting Admin or Owner", () => {
      expect(canGrantRole(ROLE_LEVELS.ADMIN, ROLE_LEVELS.MEMBER)).toBe(true);
      expect(canGrantRole(ROLE_LEVELS.ADMIN, ROLE_LEVELS.GUEST)).toBe(true);

      // Cannot grant peer or higher
      expect(canGrantRole(ROLE_LEVELS.ADMIN, ROLE_LEVELS.ADMIN)).toBe(false);
      expect(canGrantRole(ROLE_LEVELS.ADMIN, ROLE_LEVELS.OWNER)).toBe(false);
    });
  });

  describe("calculateEffectivePermissions (Runtime intersection defense)", () => {
    it("returns key permissions if user role has wildcard", () => {
      const perms = calculateEffectivePermissions(["media:search", "media:detail"], ["*"]);
      expect(perms).toEqual(["media:search", "media:detail"]);
    });

    it("returns user role permissions if key has wildcard", () => {
      const perms = calculateEffectivePermissions(["*"], ["media:search", "storage:list"]);
      expect(perms).toEqual(["media:search", "storage:list"]);
    });

    it("computes strict intersection to revoke permissions if user was demoted", () => {
      // Key was created with storage:delete when user was Admin
      const keyPerms = ["media:search", "storage:delete"];
      // User was later demoted to Guest
      const guestPerms = BUILTIN_ROLES.role_guest.permissions; // only media:search, media:detail, system:health

      const effective = calculateEffectivePermissions(keyPerms, guestPerms);
      expect(effective).toEqual(["media:search"]);
      expect(effective).not.toContain("storage:delete");
    });
  });
});
