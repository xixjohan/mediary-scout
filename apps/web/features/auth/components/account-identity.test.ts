import { describe, expect, it } from "vitest";
import {
  formatAccountDisplayName,
  formatAccountInitial,
} from "./account-identity";

describe("account-identity: Hydration consistency and formatting", () => {
  describe("formatAccountDisplayName", () => {
    it("maps default account sentinels to 管理员", () => {
      expect(formatAccountDisplayName("default")).toBe("管理员");
      expect(formatAccountDisplayName("acct_default")).toBe("管理员");
      expect(formatAccountDisplayName(" default ")).toBe("管理员");
    });

    it("falls back to 管理员 when input is missing or empty", () => {
      expect(formatAccountDisplayName(null)).toBe("管理员");
      expect(formatAccountDisplayName(undefined)).toBe("管理员");
      expect(formatAccountDisplayName("")).toBe("管理员");
      expect(formatAccountDisplayName("   ")).toBe("管理员");
    });

    it("preserves custom user names", () => {
      expect(formatAccountDisplayName("alice")).toBe("alice");
      expect(formatAccountDisplayName(" bob ")).toBe("bob");
      expect(formatAccountDisplayName("张三")).toBe("张三");
    });
  });

  describe("formatAccountInitial", () => {
    it("computes uppercase first letter for custom names", () => {
      expect(formatAccountInitial("alice")).toBe("A");
      expect(formatAccountInitial("bob")).toBe("B");
      expect(formatAccountInitial("张三")).toBe("张");
    });

    it("consistently computes 管 for default account sentinels", () => {
      expect(formatAccountInitial("default")).toBe("管");
      expect(formatAccountInitial("acct_default")).toBe("管");
      expect(formatAccountInitial("管理员")).toBe("管");
      expect(formatAccountInitial(null)).toBe("管");
      expect(formatAccountInitial(undefined)).toBe("管");
      expect(formatAccountInitial("")).toBe("管");
    });
  });

  describe("Server & Client Parity (Hydration Safety Guarantee)", () => {
    it("guarantees zero mismatch between SSR props and Client Auth context for default admin", () => {
      // Server renders from DB summary: summary.username === "default"
      const serverPropUsername = "default";
      const serverDisplayName = formatAccountDisplayName(serverPropUsername);
      const serverInitial = formatAccountInitial(serverDisplayName);

      // Client hook resolves from /api/auth/me: user.username === "default"
      const clientAuthUser = { username: "default" };
      const clientDisplayName = formatAccountDisplayName(clientAuthUser.username || serverPropUsername);
      const clientInitial = formatAccountInitial(clientDisplayName);

      // Absolute byte-for-byte identity to prevent React 19 Hydration mismatch & Turbopack reload loop
      expect(clientDisplayName).toBe(serverDisplayName);
      expect(clientInitial).toBe(serverInitial);
      expect(serverInitial).toBe("管");
      expect(serverDisplayName).toBe("管理员");
    });

    it("guarantees zero mismatch for custom users", () => {
      const serverPropUsername = "family_member";
      const serverDisplayName = formatAccountDisplayName(serverPropUsername);
      const serverInitial = formatAccountInitial(serverDisplayName);

      const clientAuthUser = { username: "family_member" };
      const clientDisplayName = formatAccountDisplayName(clientAuthUser.username || serverPropUsername);
      const clientInitial = formatAccountInitial(clientDisplayName);

      expect(clientDisplayName).toBe(serverDisplayName);
      expect(clientInitial).toBe(serverInitial);
      expect(serverInitial).toBe("F");
      expect(serverDisplayName).toBe("family_member");
    });
  });
});
