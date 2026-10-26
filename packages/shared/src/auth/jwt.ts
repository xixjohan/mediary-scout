import { SignJWT, jwtVerify } from "jose";

/**
 * JWT 颁发与验证（S5.3，需求 #2）。
 *
 * 库：jose（MIT、0 依赖、Web Crypto）——RFC 7519 全套，`alg: none` 默认拒绝，
 * 验证端必须显式声明期望算法（防 algorithm-confusion）。
 * 对比结论见 docs/api-key-auth-and-self-update.md §3。
 *
 * 职责边界：这里只做**密码学**（签/验），不管 secret 从哪来（env/DB 的解析在
 * apps/web，那里能读 repository）、也不管 account 是否有效（那是路由的事）。
 * secret 由调用方传入，保持本模块纯函数、可单测。
 */

/** 唯一允许的算法。验证端写死，不接受 token 自报的 alg。 */
export const JWT_ALG = "HS256";

export interface TokenClaims {
  /** account id（多用户实例的用户，单用户实例的 owner） */
  sub: string;
  iat?: number;
  exp?: number;
}

function keyOf(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** 签发 token。ttlSeconds 由调用方给（默认 12h 在 apps/web 的常量里）。 */
export async function issueToken(claims: TokenClaims, secret: string, ttlSeconds: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: JWT_ALG })
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(keyOf(secret));
}

/**
 * 验证 token 并返回 claims。任何不合格（过期/篡改/错算法/格式错）都 **reject**
 * ——调用方统一转 401，不区分原因（防枚举）。
 */
export async function verifyToken(token: string, secret: string): Promise<TokenClaims> {
  const { payload } = await jwtVerify(token, keyOf(secret), { algorithms: [JWT_ALG] });
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("JWT_MISSING_SUB");
  }
  const claims: TokenClaims = { sub: payload.sub };
  if (typeof payload.iat === "number") claims.iat = payload.iat;
  if (typeof payload.exp === "number") claims.exp = payload.exp;
  return claims;
}
