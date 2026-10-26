import { describe, it, expect } from "vitest";
import { SignJWT, jwtVerify } from "jose";
import { issueToken, verifyToken, type TokenClaims, JWT_ALG } from "./jwt.js";

/**
 * S5.3 TDD：API key 换 JWT。
 *
 * 关键属性：round-trip、过期拒绝、篡改拒绝、**算法固定 HS256**
 * （防 algorithm-confusion：验证端显式声明期望算法，不接受 token 自报）。
 */

const SECRET = "test-secret-32-bytes-long-xxxxxxxx";
const KEY = new TextEncoder().encode(SECRET);

function base(overrides: Partial<TokenClaims> = {}): TokenClaims {
  return { sub: "acct_1", ...overrides };
}

describe("issueToken / verifyToken", () => {
  it("round-trip：签出的 token 验回同样的 claims", async () => {
    const token = await issueToken(base({ sub: "acct_42" }), SECRET, 600);
    const claims = await verifyToken(token, SECRET);
    expect(claims.sub).toBe("acct_42");
    expect(typeof claims.iat).toBe("number");
    expect(typeof claims.exp).toBe("number");
    expect(claims.exp! - claims.iat!).toBe(600);
  });

  it("存活期可调（默认 12h 由调用方决定，这里传 1s 验证过期）", async () => {
    const token = await issueToken(base(), SECRET, -1); // 已过期
    await expect(verifyToken(token, SECRET)).rejects.toThrow();
  });

  it("篡改 payload → 拒绝", async () => {
    const token = await issueToken(base({ sub: "acct_1" }), SECRET, 600);
    const [header, payload, signature] = token.split(".") as [string, string, string];
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), sub: "acct_admin" }))
      .toString("base64url");
    await expect(verifyToken(`${header}.${tampered}.${signature}`, SECRET)).rejects.toThrow();
  });

  it("换了 secret → 拒绝", async () => {
    const token = await issueToken(base(), SECRET, 600);
    await expect(verifyToken(token, "another-secret-32-bytes-long-yyyyyy")).rejects.toThrow();
  });

  it("算法固定 HS256：token 自称 alg=none / 其它算法一律拒绝", async () => {
    // 手工签一个 HS512 的 token——验证端应拒绝（防 algorithm-confusion）
    const hs512 = await new SignJWT({ sub: "acct_1" })
      .setProtectedHeader({ alg: "HS512" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(KEY);
    await expect(verifyToken(hs512, SECRET)).rejects.toThrow();
    expect(JWT_ALG).toBe("HS256");
  });

  it("垃圾串 / 空串 → 拒绝且不抛未捕获错误", async () => {
    await expect(verifyToken("", SECRET)).rejects.toThrow();
    await expect(verifyToken("not-a-jwt", SECRET)).rejects.toThrow();
    await expect(verifyToken("a.b.c", SECRET)).rejects.toThrow();
  });

  it("jose 正确性交叉验证：同一 secret 下 jose 原生验得过我们签的 token", async () => {
    const token = await issueToken(base({ sub: "acct_x" }), SECRET, 600);
    const { payload } = await jwtVerify(token, KEY, { algorithms: ["HS256"] });
    expect(payload.sub).toBe("acct_x");
  });
});
