export const UNAUTHENTICATED_ACCOUNT_ID = "acct_unauthenticated";
export const DEFAULT_ACCOUNT_ID = "acct_default";
export const SESSION_COOKIE_NAME = "mt_session";
export const SESSION_SECRET_SETTING_KEY = "session_secret";
export const JWT_SECRET_SETTING_KEY = "jwt_secret";

export type LoginPasswordState = boolean | "unknown";

export type AuthOutcome =
  | { ok: true; accountId: string; signedCookie: string }
  | { ok: false; error: string };

export interface ManagedAccount {
  id: string;
  username: string;
  isOwner: boolean;
  createdAt: string;
  driveCount: number;
}

export interface AccountBootstrapState {
  hasAccounts: boolean;
  hasLibrary: boolean;
  ready: boolean;
}

export class UnauthenticatedAccountError extends Error {
  constructor(message = "未登录，请先登录后再操作。") {
    super(message);
    this.name = "UnauthenticatedAccountError";
  }
}

export type ExecutionIdentityScope =
  | { type: "http-request"; headers?: Headers; sessionCookie?: string }
  | { type: "background-worker"; accountId?: string };
