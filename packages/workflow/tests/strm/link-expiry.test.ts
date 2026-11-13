import { describe, expect, it } from "vitest";
import { isExpiredLinkStatus, shouldRetryWithFreshLink } from "../../src/strm/link-expiry.js";

describe("isExpiredLinkStatus", () => {
  it("401/403/410 视为链接失效", () => {
    expect(isExpiredLinkStatus(401)).toBe(true);
    expect(isExpiredLinkStatus(403)).toBe(true);
    expect(isExpiredLinkStatus(410)).toBe(true);
  });

  it("其余状态不触发自愈（含 404/429/500，语义不同）", () => {
    for (const status of [200, 206, 302, 404, 429, 500, 502, 504]) {
      expect(isExpiredLinkStatus(status)).toBe(false);
    }
  });
});

describe("shouldRetryWithFreshLink", () => {
  it("仅当「来自缓存」且「状态为过期」时重试", () => {
    expect(shouldRetryWithFreshLink({ status: 403, fromCache: true })).toBe(true);
    expect(shouldRetryWithFreshLink({ status: 403, fromCache: false })).toBe(false);
    expect(shouldRetryWithFreshLink({ status: 206, fromCache: true })).toBe(false);
    expect(shouldRetryWithFreshLink({ status: 429, fromCache: true })).toBe(false);
  });
});
