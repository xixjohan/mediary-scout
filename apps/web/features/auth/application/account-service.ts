import { randomBytes } from "node:crypto";
import {
  DEFAULT_ACCOUNT_ID,
  DuplicateUsernameError,
  generateSessionId,
  hashPassword,
  isSessionExpired,
  signSession,
  verifyPassword,
  verifySession,
  type Account,
  type WorkflowRepository,
} from "@media-track/workflow";
import { verifyToken, issueToken } from "@media-track/shared";
import {
  getWorkflowRepository,
  getSessionSecretCache,
  setSessionSecretCache,
  getJwtSecretCache,
  setJwtSecretCache,
} from "../../../composition/runtime-container";
import {
  JWT_SECRET_SETTING_KEY,
  SESSION_SECRET_SETTING_KEY,
  type AccountBootstrapState,
  type AuthOutcome,
  type LoginPasswordState,
  type ManagedAccount,
} from "../contracts/auth-tokens";
import {
  canManageAccounts,
  deriveBootstrapState,
  resolveRegistration,
} from "../core/account-bootstrap";
import { parseBearerToken } from "../core/bearer-scheme";
import {
  checkLoginAllowed,
  normalizeThrottleKey,
  recordLoginFailure,
  recordLoginSuccess,
} from "../core/login-throttle";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DUMMY_HASH =
  "scrypt:a2448ef076990b889ef0540720bccce2:4fdc41afebb4560f4a638b4225d8325904894d18d2df1c7a95c50a65c141b926dc252e99b63e681e15e2d6e008acc845b02c9a2fc99a4888749226ab262c6978";

export function isMultiUserEnabled(): boolean {
  return process.env.MEDIA_TRACK_MULTI_USER === "1";
}

export function isCookieSecure(request: {
  headers: { get(name: string): string | null };
  nextUrl?: { protocol?: string };
}): boolean {
  const explicit = process.env.MEDIA_TRACK_COOKIE_SECURE?.trim();
  if (explicit === "0") return false;
  if (explicit === "1") return true;

  const normalizeScheme = (raw: string) => raw.trim().toLowerCase().replace(/:$/, "");
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) {
    return normalizeScheme(forwarded.split(",")[0]!) === "https";
  }
  return normalizeScheme(request.nextUrl?.protocol ?? "") === "https";
}

export async function getSessionSecret(): Promise<string> {
  const cached = getSessionSecretCache();
  if (cached) return cached;

  const envSecret = process.env.MEDIA_TRACK_SESSION_SECRET?.trim();
  if (envSecret) {
    setSessionSecretCache(envSecret);
    return envSecret;
  }

  const repo = getWorkflowRepository();
  const stored = (await repo.getSetting(SESSION_SECRET_SETTING_KEY))?.trim();
  if (stored) {
    setSessionSecretCache(stored);
    return stored;
  }

  const generated = randomBytes(32).toString("hex");
  await repo.setSetting(SESSION_SECRET_SETTING_KEY, generated);
  setSessionSecretCache(generated);
  return generated;
}

export async function getJwtSecret(): Promise<string> {
  const cached = getJwtSecretCache();
  if (cached) return cached;

  const envSecret = process.env.MEDIA_TRACK_JWT_SECRET?.trim();
  if (envSecret) {
    setJwtSecretCache(envSecret);
    return envSecret;
  }

  const repo = getWorkflowRepository();
  const stored = (await repo.getSetting(JWT_SECRET_SETTING_KEY))?.trim();
  if (stored) {
    setJwtSecretCache(stored);
    return stored;
  }

  const generated = randomBytes(32).toString("hex");
  await repo.setSetting(JWT_SECRET_SETTING_KEY, generated);
  setJwtSecretCache(generated);
  return generated;
}

export function getJwtTtlSeconds(): number | null {
  const raw = process.env.MEDIA_TRACK_JWT_TTL_SECONDS?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export async function issueUserJwt(
  accountId: string,
  options?: { ttlSeconds?: number | null },
): Promise<string> {
  const secret = await getJwtSecret();
  const ttl = options?.ttlSeconds ?? getJwtTtlSeconds();
  return issueToken({ sub: accountId }, secret, ttl ?? 43200);
}

export async function createLoginSession(accountId: string): Promise<string> {
  const repo = getWorkflowRepository();
  const sessionId = generateSessionId();
  const nowMs = Date.now();
  await repo.createSession({
    id: sessionId,
    accountId,
    expiresAt: new Date(nowMs + SESSION_TTL_MS).toISOString(),
    createdAt: new Date(nowMs).toISOString(),
  });
  return signSession(sessionId, await getSessionSecret());
}

export async function resolveSessionAccountId(signedCookie: string): Promise<string | null> {
  const secret = await getSessionSecret();
  const sessionId = verifySession(signedCookie, secret);
  if (!sessionId) return null;

  const session = await getWorkflowRepository().getSession(sessionId);
  if (!session || isSessionExpired(session.expiresAt, new Date().toISOString())) {
    return null;
  }
  return session.accountId;
}

export async function resolveBearerAccountId(
  headers: Headers | { get(name: string): string | null } | undefined,
): Promise<string | null> {
  const token = parseBearerToken(headers?.get("authorization"));
  if (!token) return null;
  try {
    const claims = await verifyToken(token, await getJwtSecret());
    return claims.sub;
  } catch {
    return null;
  }
}

export async function hasLoginPassword(): Promise<LoginPasswordState> {
  try {
    const acct = await getWorkflowRepository().getAccountById(DEFAULT_ACCOUNT_ID);
    return Boolean(acct && acct.passwordHash.length > 0);
  } catch {
    return "unknown";
  }
}

export async function registerAccount(
  username: string,
  password: string,
): Promise<AuthOutcome> {
  const trimmed = username.trim();
  if (trimmed.length < 2 || password.length < 6) {
    return { ok: false, error: "用户名至少 2 位、密码至少 6 位。" };
  }

  const repo = getWorkflowRepository();
  const passwordHash = await hashPassword(password);
  const decision = resolveRegistration(await repo.listAccounts());

  try {
    if (decision.kind === "adopt-default") {
      await repo.adoptDefaultAccount({ username: trimmed, passwordHash });
      return {
        ok: true,
        accountId: DEFAULT_ACCOUNT_ID,
        signedCookie: await createLoginSession(DEFAULT_ACCOUNT_ID),
      };
    }

    const account: Account = {
      id: `acct_${randomBytes(12).toString("hex")}`,
      username: trimmed,
      passwordHash,
      groupId: null,
      isOwner: false,
      createdAt: new Date().toISOString(),
    };
    await repo.createAccount(account);
    return {
      ok: true,
      accountId: account.id,
      signedCookie: await createLoginSession(account.id),
    };
  } catch (error) {
    if (error instanceof DuplicateUsernameError) {
      return { ok: false, error: "用户名已存在。" };
    }
    throw error;
  }
}

async function getLoginTargetAccount(
  repo: WorkflowRepository,
  username: string,
): Promise<Account | null> {
  if (isMultiUserEnabled()) {
    return repo.getAccountByUsername(username.trim());
  }
  return repo.getAccountById(DEFAULT_ACCOUNT_ID);
}

export async function loginAccount(
  username: string,
  password: string,
  throttleKey?: string,
): Promise<AuthOutcome> {
  const key = normalizeThrottleKey(
    throttleKey ?? (isMultiUserEnabled() ? username : DEFAULT_ACCOUNT_ID),
  );
  const now = Date.now();
  const verdict = checkLoginAllowed(key, now);
  if (!verdict.allowed) {
    return { ok: false, error: `尝试过于频繁，请 ${verdict.retryAfterSec} 秒后再试。` };
  }

  const repo = getWorkflowRepository();
  const account = await getLoginTargetAccount(repo, username);
  const hash = account?.passwordHash || DUMMY_HASH;
  const valid = await verifyPassword(password, hash);

  if (!account || !valid || account.passwordHash.length === 0) {
    recordLoginFailure(key, now);
    return {
      ok: false,
      error: isMultiUserEnabled() ? "用户名或密码不正确。" : "密码不正确。",
    };
  }

  const signedCookie = await createLoginSession(account.id);
  recordLoginSuccess(key);
  return { ok: true, accountId: account.id, signedCookie };
}

export async function logoutSession(signedCookie: string | undefined): Promise<void> {
  if (!signedCookie) return;
  const sessionId = verifySession(signedCookie, await getSessionSecret());
  if (sessionId) {
    await getWorkflowRepository().deleteSession(sessionId);
  }
}

export async function setSingleUserPassword(
  newPassword: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (newPassword.length < 6) return { ok: false, error: "密码至少 6 位。" };
  const repo = getWorkflowRepository();
  await repo.setAccountPassword(DEFAULT_ACCOUNT_ID, await hashPassword(newPassword));
  await repo.deleteSessionsForAccount(DEFAULT_ACCOUNT_ID);
  return { ok: true };
}

export async function clearSingleUserPassword(): Promise<void> {
  const repo = getWorkflowRepository();
  await repo.setAccountPassword(DEFAULT_ACCOUNT_ID, "");
  await repo.deleteSessionsForAccount(DEFAULT_ACCOUNT_ID);
}

export async function changeOwnPassword(
  accountId: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (newPassword.length < 6) return { ok: false, error: "新密码至少 6 位。" };
  const repo = getWorkflowRepository();
  const acct = await repo.getAccountById(accountId);
  const valid = Boolean(
    acct && acct.passwordHash.length > 0 && (await verifyPassword(currentPassword, acct.passwordHash)),
  );
  if (!acct || !valid) return { ok: false, error: "当前密码不正确。" };

  await repo.setAccountPassword(accountId, await hashPassword(newPassword));
  await repo.deleteSessionsForAccount(accountId);
  return { ok: true };
}

export async function resetUserPassword(
  ownerAccountId: string,
  targetAccountId: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const repo = getWorkflowRepository();
  const owner = await repo.getAccountById(ownerAccountId);
  if (!canManageAccounts(owner)) return { ok: false, error: "无权限。" };
  if (newPassword.length < 6) return { ok: false, error: "新密码至少 6 位。" };

  const target = await repo.getAccountById(targetAccountId);
  if (!target) return { ok: false, error: "账号不存在。" };

  await repo.setAccountPassword(targetAccountId, await hashPassword(newPassword));
  await repo.deleteSessionsForAccount(targetAccountId);
  return { ok: true };
}

export async function getBootstrapState(): Promise<{
  needsClaim: boolean;
  hasExistingLibrary: boolean;
}> {
  const repo = getWorkflowRepository();
  const accounts = await repo.listAccounts();
  const library = await repo.listTrackedSeasonStates(DEFAULT_ACCOUNT_ID);
  return deriveBootstrapState(accounts, library.length);
}

export async function listManagedAccounts(
  ownerAccountId: string,
): Promise<ManagedAccount[] | null> {
  const repo = getWorkflowRepository();
  const owner = await repo.getAccountById(ownerAccountId);
  if (!canManageAccounts(owner)) return null;

  const accounts = await repo.listAccounts();
  const summaries: ManagedAccount[] = [];
  for (const account of accounts) {
    const drives = await repo.listConnectedStorages(account.id);
    summaries.push({
      id: account.id,
      username: account.username,
      isOwner: account.isOwner,
      createdAt: account.createdAt,
      driveCount: drives.length,
    });
  }
  return summaries;
}
