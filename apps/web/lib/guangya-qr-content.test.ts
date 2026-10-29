import { describe, expect, it } from "vitest";
import { buildGuangYaQrContent } from "./guangya-qr-content";

/** The exact value the real site handed to its QR canvas on 2026-10-26. */
const LIVE_VERIFICATION_URL =
  "https://account.guangyapan.com/__/auth/device/?client_id=aMe-8VSlkrbQXpUR&scope=user%20profile%20sso%20offline";

describe("buildGuangYaQrContent", () => {
  it("appends user_code — the parameter whose absence made scans 404", () => {
    const out = new URL(
      buildGuangYaQrContent({ verificationUrl: LIVE_VERIFICATION_URL, userCode: "AWrfZhuaq-jGBr7e-g" }),
    );
    expect(out.searchParams.get("user_code")).toBe("AWrfZhuaq-jGBr7e-g");
    expect(out.searchParams.get("client_id")).toBe("aMe-8VSlkrbQXpUR");
    expect(out.searchParams.get("scope")).toBe("user profile sso offline");
    expect(out.origin + out.pathname).toBe(
      "https://account.guangyapan.com/__/auth/device/",
    );
  });

  it("matches the parameter set the real site encodes", () => {
    const out = new URL(
      buildGuangYaQrContent({ verificationUrl: LIVE_VERIFICATION_URL, userCode: "AWrfZhuaq-jGBr7e-g" }),
    );
    expect([...out.searchParams.keys()].sort()).toEqual(["client_id", "scope", "user_code"]);
  });

  it("uses ? when the url has no query string yet", () => {
    const out = buildGuangYaQrContent({ verificationUrl: "https://account.guangyapan.com/x", userCode: "abc" });
    expect(out).toBe("https://account.guangyapan.com/x?user_code=abc");
  });

  it("round-trips a user_code containing reserved characters", () => {
    const plain = buildGuangYaQrContent({ verificationUrl: LIVE_VERIFICATION_URL, userCode: "a-b_c.d~e" });
    expect(new URL(plain).searchParams.get("user_code")).toBe("a-b_c.d~e");
    const weird = buildGuangYaQrContent({ verificationUrl: LIVE_VERIFICATION_URL, userCode: "a&b=c" });
    expect(weird.match(/user_code=/g)).toHaveLength(1);
    expect(new URL(weird).searchParams.get("user_code")).toBe("a&b=c");
  });

  it("does not duplicate an existing user_code", () => {
    const withCode = `${LIVE_VERIFICATION_URL}&user_code=OLD`;
    const out = buildGuangYaQrContent({ verificationUrl: withCode, userCode: "NEW" });
    expect(out.match(/user_code=/g)).toHaveLength(1);
    expect(out).toContain("user_code=NEW");
    expect(out).not.toContain("OLD");
  });

  it("returns the url unchanged when there is no user code", () => {
    expect(buildGuangYaQrContent({ verificationUrl: LIVE_VERIFICATION_URL, userCode: "" })).toBe(
      LIVE_VERIFICATION_URL,
    );
  });
});
