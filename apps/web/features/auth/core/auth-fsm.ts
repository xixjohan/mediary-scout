/**
 * 前端认证有限状态机 (Finite State Machine)
 *
 * 显式管理前端用户的生命周期状态，杜绝多个分散 Boolean 标志
 * （如 isLoading, isLoggedIn, isError）产生的非法中间状态。
 */

export type AuthStatus =
  | "idle"
  | "authenticating"
  | "authenticated"
  | "unauthenticated"
  | "session_expired"
  | "error";

export interface UserRoleSummary {
  id: string;
  name: string;
  level: number;
}

export interface UserProfile {
  id: string;
  username: string;
  isOwner: boolean;
  role: UserRoleSummary;
  permissions: string[];
  storageCount: number;
  createdAt: string;
}

export type AuthEvent =
  | { type: "INIT_START" }
  | { type: "INIT_SUCCESS"; payload: UserProfile }
  | { type: "INIT_UNAUTHENTICATED" }
  | { type: "LOGIN_SUBMIT" }
  | { type: "LOGIN_SUCCESS"; payload: UserProfile }
  | { type: "LOGIN_FAILURE"; error: string }
  | { type: "LOGOUT" }
  | { type: "SESSION_EXPIRED" };

export interface AuthState {
  status: AuthStatus;
  user: UserProfile | null;
  error: string | null;
}

export const INITIAL_AUTH_STATE: AuthState = {
  status: "idle",
  user: null,
  error: null,
};

export function authReducer(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case "INIT_START":
    case "LOGIN_SUBMIT":
      return {
        ...state,
        status: "authenticating",
        error: null,
      };

    case "INIT_SUCCESS":
    case "LOGIN_SUCCESS":
      return {
        status: "authenticated",
        user: event.payload,
        error: null,
      };

    case "INIT_UNAUTHENTICATED":
    case "LOGOUT":
      return {
        status: "unauthenticated",
        user: null,
        error: null,
      };

    case "LOGIN_FAILURE":
      return {
        status: "error",
        user: null,
        error: event.error,
      };

    case "SESSION_EXPIRED":
      return {
        status: "session_expired",
        user: null,
        error: "登录已失效，请重新登录",
      };

    default:
      return state;
  }
}
