import { describe, expect, it } from "vitest";
import {
  maskSecret,
  maskPan115Cookie,
  getCredentialStrategy,
} from "../../src/storage/credential-strategy.js";

describe("credential-strategy", () => {
  it("maskSecret masks the middle of secrets", () => {
    expect(maskSecret("abcdefghijklmn", 3, 3)).toBe("abc****lmn");
    expect(maskSecret("short", 4, 4)).toBe("****");
    expect(maskSecret("")).toBe("");
  });

  it("maskPan115Cookie masks UID, CID, SEID specifically", () => {
    const raw = "UID=1319001; CID=998877; SEID=abcdef1234567890; foo=bar";
    const masked = maskPan115Cookie(raw);
    expect(masked).toContain("UID=13****01");
    expect(masked).toContain("CID=99****77");
    expect(masked).toContain("SEID=ab****90");
    expect(masked).not.toContain("1319001");
    expect(masked).not.toContain("abcdef1234567890");
  });

  it("Pan115CredentialStrategy computes masked summary and reveal payload correctly", () => {
    const strategy = getCredentialStrategy("pan115");
    const payload = {
      cookie: "UID=1234567; CID=888888; SEID=secret_session_token",
      openOAuth: {
        accessToken: "access_token_123456789",
        refreshToken: "refresh_token_987654321",
        expiresAt: Date.now() + 3600 * 1000,
        clientId: "client_app_id",
      },
    };

    const summary = strategy.getMaskedSummary(payload);
    expect(summary.engineMode).toBe("dual_engine");
    expect(summary.hasCookie).toBe(true);
    expect(summary.hasOpenOAuth).toBe(true);
    expect(summary.maskedCookie).toContain("UID=12****67");
    expect(summary.maskedAccessToken).toBe("acce****6789");
    expect(summary.maskedRefreshToken).toBe("refr****4321");
    expect(summary.tokenExpiresInSec).toBeGreaterThan(3500);

    const revealed = strategy.reveal(payload);
    expect(revealed.cookie).toBe(payload.cookie);
    expect(revealed.openOAuth?.accessToken).toBe(payload.openOAuth.accessToken);
    expect(revealed.openOAuth?.refreshToken).toBe(payload.openOAuth.refreshToken);
  });
});
