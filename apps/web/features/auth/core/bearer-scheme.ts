/**
 * Authorization 头里 Bearer 方案的唯一解析规则。
 */
export function parseBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const token = match[1]!.trim();
  return token.length > 0 ? token : null;
}
