import { verifyStrmPlayToken } from "./strm-writer.js";

/**
 * `.strm` 内容自愈判定（只读文件内容 + 纯 CPU HMAC，零网盘调用）。
 *
 * 缺陷原型（2026-11-17 验收实测）：签名 secret 从硬编码常量改为实例 JWT secret
 * 之后，磁盘上**已存在**的 `.strm` 全部带着旧 secret 签出的 token。而扫描器的
 * 「增量补缺」（`incremental_missing`）模式**只生成缺失文件、从不比较已存在的**
 * （只有 `incremental_update` / `full_sync` 才比对内容），于是这些文件永远
 * 401、且没有任何重写路径——用户看到的就是「`.strm` 忽然播不了了」。
 *
 * 判定内容是否需要重写，三个独立理由：
 *  1. **指向别的任务/文件**：播放路径里的 taskId/fileId 与本次扫描不一致
 *     （任务绑定或文件 id 变了），旧 URL 指向错误实体；
 *  2. **token 无法验签**：secret 轮换后旧 token 的签名不再成立（最常见）；
 *  3. **token 已过期**：默认 TTL 365 天，但 `STRM_SECRET` 显式配置时可能是短周期。
 *
 * 不重写的情形也同样明确：签名有效且未过期、且 task/file 一致 —— 增量模式
 * 应当保持「不碰没坏的文件」，避免每次扫描都对整盘做 IO。
 */
export interface StrmContentVerdictInput {
  /** 磁盘上该 `.strm` 的当前内容（已 trim）。 */
  content: string;
  /** 本次扫描期望的 taskId / fileId。 */
  taskId: string;
  fileId: string;
  /** 期望的完整播放 URL（用于区分「内容完全相同」这种最省的情况）。 */
  expectedPlayUrl: string;
  /** 注入时钟（epoch 秒），便于测试。 */
  nowEpochSeconds?: number | undefined;
}

export type StrmContentVerdict =
  /** 内容与期望完全一致，无需动作。 */
  | { kind: "unchanged" }
  /** 需要重写，附带原因（审计/日志用，也让测试能精确断言是哪个分支）。 */
  | {
      kind: "rewrite";
      reason: "different_target" | "invalid_token" | "expired_token" | "not_a_play_url" | "different_content";
    };

/** 从播放 URL 里取出 `/api/strm/play/<taskId>/<fileId>` 两段（已 decode）。 */
export function parsePlayUrlTarget(url: string): { taskId: string; fileId: string } | null {
  const raw = url.trim();
  let pathname: string;
  try {
    pathname = new URL(raw).pathname;
  } catch {
    // 相对路径（`/strm/play/t/f`）：`new URL` 没有 base 会抛，改成按原串匹配。
    if (!raw.startsWith("/")) return null;
    pathname = raw.split("?")[0]!.split("#")[0]!;
  }
  const match = /\/(?:api\/)?strm\/play\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match?.[1] || !match?.[2]) return null;
  try {
    return { taskId: decodeURIComponent(match[1]), fileId: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

/**
 * 判定一个已存在的 `.strm` 是否必须重写。**纯函数**，不读盘、不看 env 之外的全局状态
 * （secret 由 `verifyStrmPlayToken` 内部的 `resolveStrmSigningSecret()` 取）。
 */
export function judgeStrmContent(input: StrmContentVerdictInput): StrmContentVerdict {
  const content = input.content.trim();
  const expected = input.expectedPlayUrl.trim();

  // 完全相同 → 无需动作（最常见：增量扫描的稳态）。
  if (content === expected) return { kind: "unchanged" };

  const target = parsePlayUrlTarget(content);
  if (target === null) {
    // 不是一条播放 URL（被手改/被别的工具写过）→ 必须按期望重写。
    return { kind: "rewrite", reason: "not_a_play_url" };
  }
  if (target.taskId !== input.taskId || target.fileId !== input.fileId) {
    return { kind: "rewrite", reason: "different_target" };
  }

  let parsed: URL;
  try {
    parsed = new URL(content);
  } catch {
    return { kind: "rewrite", reason: "not_a_play_url" };
  }
  const token = parsed.searchParams.get("token");
  const expRaw = parsed.searchParams.get("exp");
  const exp = expRaw !== null && Number.isFinite(Number(expRaw)) ? Number(expRaw) : null;

  // 无 token：若实例并未强制签名（STRM_AUTH_STRICT 关闭）也能播，但既然期望 URL
  // 带签名，就按「应带而未带」重写——让磁盘状态与生成策略一致。
  if (token === null || exp === null) {
    return { kind: "rewrite", reason: "invalid_token" };
  }

  const verdict = verifyStrmPlayToken({
    taskId: input.taskId,
    fileId: input.fileId,
    token,
    expiresAtEpochSeconds: exp,
    ...(input.nowEpochSeconds === undefined ? {} : { nowEpochSeconds: input.nowEpochSeconds }),
  });
  if (verdict.valid) {
    // 签名有效但内容与期望不同（例如 name= 参数变化）→ 仍按期望重写。
    return { kind: "rewrite", reason: "different_content" };
  }
  return {
    kind: "rewrite",
    reason: verdict.reason === "token_expired" ? "expired_token" : "invalid_token",
  };
}
