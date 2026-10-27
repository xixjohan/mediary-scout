/**
 * @media-track/shared — 无业务属主的共享基础层。
 *
 * 当前模块：
 *   - crypto/credential-crypto  AES-256-GCM 凭据信封加密（任务单 S1.5，P15）
 *
 * 规划子模块（按 Sprint 任务单逐步落地，见 docs/architecture-optimization-workflow.md）：
 *   - http-client/   带超时、重试与出站白名单的 fetch    （S4，P17 SSRF）
 *   - rate-limiter/  令牌桶 / 漏桶限速                   （S3.3，P13 封号风险）
 *   - logger/        结构化日志                          （S2）
 */

export { parseReleaseTag, type ReleaseTag } from "./release-tag.js";

export {
  API_KEY_SETTING_KEY,
  generateApiKey,
  maskApiKey,
  resolveApiKey,
  type ApiKeyOrigin,
  type IApiKeyStore,
  type ResolvedApiKey,
} from "./api-key-source.js";

export { issueToken, verifyToken, JWT_ALG, type TokenClaims } from "./auth/jwt.js";

export {
  backupSqliteDatabase,
  compareSqliteBackup,
  restoreSqliteBackup,
  verifySqliteBackup,
  type BackupVerification,
} from "./sqlite-backup.js";

export {
  LeakyBucketPacer,
  NoopPacer,
  TokenBucketPacer,
  createBrandPacer,
  type Pacer,
  type PacerDeps,
} from "./rate-limiter.js";

export {
  ENC_PREFIX,
  decryptSecret,
  encryptSecret,
  initCredentialCrypto,
  initCredentialCryptoForDatabase,
  isCredentialCryptoInitialized,
  isEncrypted,
} from "./crypto/credential-crypto.js";
