/**
 * Authorization 头里 Bearer 方案的**唯一**解析规则。
 *
 * 为什么单独一个模块：这个正则在三个地方必须一致——proxy 的 presence 粗筛、
 * resolveBearerAccountId 的精确判定、以及五个测试文件里的 mock 复刻版。此前
 * 每一处都自己写一份 `/^bearer (.+)$/i`，第四轮复核对真实实现做变异（去掉
 * token.trim()）时，6 个文件 98 个用例全绿——mock 与真实实现漂移了，而注释
 * 还写着「与真实实现同一语义」。抽出来后测试 mock 直接 import 真规则，
 * 漂移在结构上不可能发生。
 *
 * 语义（RFC 7235：scheme 大小写无关；token 前后空白忽略）：
 *   · `Bearer <token>` / `bearer <token>` / `BeArEr <token>` → 认
 *   · `Bearer`（无 token）/ `Bearer `（空白 token）/ `Basic xyz` / 无头 → null
 */

/** 从 Authorization 头里取出 Bearer token；不是 Bearer 方案或没有 token 返回 null。 */
export function parseBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  // \s 而非字面空格：proxy 的 presence 粗筛是 /^bearer\s/i，精判收紧一个
  // 字符类就会把「proxy 放行、路由 401」的分裂翻出来（第四轮复核实测：
  // Bearer<tab><jwt> 过得了 proxy、路由层 401）。
  const match = /^bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const token = match[1]!.trim();
  return token.length > 0 ? token : null;
}
