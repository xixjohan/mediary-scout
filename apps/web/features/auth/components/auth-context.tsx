"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import {
  authReducer,
  INITIAL_AUTH_STATE,
  type AuthState,
  type UserProfile,
} from "../core/auth-fsm";

export interface AuthContextValue extends AuthState {
  isAuthenticated: boolean;
  isAuthenticating: boolean;
  isOwner: boolean;
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<UserProfile | null>;
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AUTH_EVENTS = {
  SESSION_EXPIRED: "mediary:auth:session_expired",
  LOGGED_OUT: "mediary:auth:logged_out",
} as const;

export function broadcastAuthEvent(event: keyof typeof AUTH_EVENTS) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AUTH_EVENTS[event]));
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(authReducer, INITIAL_AUTH_STATE);
  const pendingProfileRef = useRef<Promise<UserProfile | null> | null>(null);

  const fetchProfile = useCallback(async (): Promise<UserProfile | null> => {
    // Single-flight promise deduplication: merge concurrent calls
    if (pendingProfileRef.current) {
      return pendingProfileRef.current;
    }

    pendingProfileRef.current = (async () => {
      try {
        const res = await fetch("/api/auth/me", {
          cache: "no-store",
          headers: { Accept: "application/json" },
        });

        if (!res.ok) {
          if (res.status === 401) {
            dispatch({ type: "INIT_UNAUTHENTICATED" });
          } else {
            dispatch({ type: "INIT_UNAUTHENTICATED" });
          }
          return null;
        }

        const data = (await res.json()) as { ok?: boolean; user?: UserProfile };
        if (data.ok && data.user) {
          dispatch({ type: "INIT_SUCCESS", payload: data.user });
          return data.user;
        }

        dispatch({ type: "INIT_UNAUTHENTICATED" });
        return null;
      } catch {
        dispatch({ type: "INIT_UNAUTHENTICATED" });
        return null;
      } finally {
        pendingProfileRef.current = null;
      }
    })();

    return pendingProfileRef.current;
  }, []);

  // Initial load
  useEffect(() => {
    dispatch({ type: "INIT_START" });
    void fetchProfile();
  }, [fetchProfile]);

  // Global session expiration listener
  useEffect(() => {
    const handleSessionExpired = () => {
      dispatch({ type: "SESSION_EXPIRED" });
    };

    window.addEventListener(AUTH_EVENTS.SESSION_EXPIRED, handleSessionExpired);
    return () => {
      window.removeEventListener(AUTH_EVENTS.SESSION_EXPIRED, handleSessionExpired);
    };
  }, []);

  const login = useCallback(
    async (username: string, password: string): Promise<{ ok: boolean; error?: string }> => {
      dispatch({ type: "LOGIN_SUBMIT" });
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });

        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (res.ok && data.ok) {
          const profile = await fetchProfile();
          if (profile) {
            return { ok: true };
          }
        }

        const errorMsg = data.error ?? "登录失败，请检查账号密码。";
        dispatch({ type: "LOGIN_FAILURE", error: errorMsg });
        return { ok: false, error: errorMsg };
      } catch {
        const errorMsg = "网络通信异常，请重试。";
        dispatch({ type: "LOGIN_FAILURE", error: errorMsg });
        return { ok: false, error: errorMsg };
      }
    },
    [fetchProfile],
  );

  const logout = useCallback(async (): Promise<void> => {
    try {
      await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    } finally {
      dispatch({ type: "LOGOUT" });
      broadcastAuthEvent("LOGGED_OUT");
      // Clear sensitive local data
      try {
        sessionStorage.clear();
      } catch {}
      window.location.href = "/login";
    }
  }, []);

  const can = useCallback(
    (permission: string): boolean => {
      if (!state.user) return false;
      if (state.user.isOwner || state.user.permissions.includes("*")) {
        return true;
      }
      return state.user.permissions.includes(permission);
    },
    [state.user],
  );

  const value: AuthContextValue = {
    ...state,
    isAuthenticated: state.status === "authenticated",
    isAuthenticating: state.status === "authenticating" || state.status === "idle",
    isOwner: state.user?.isOwner ?? false,
    login,
    logout,
    refreshProfile: fetchProfile,
    can,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuthContext must be used within an AuthProvider");
  }
  return ctx;
}
