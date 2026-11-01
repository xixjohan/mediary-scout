import { describe, expect, it } from "vitest";
import {
  authReducer,
  INITIAL_AUTH_STATE,
  type AuthState,
  type UserProfile,
} from "./auth-fsm";

describe("AuthStateMachine (authReducer)", () => {
  const dummyUser: UserProfile = {
    id: "acct_test",
    username: "alice",
    isOwner: false,
    role: { id: "role_member", name: "标准成员", level: 40 },
    permissions: ["media:search"],
    storageCount: 1,
    createdAt: "2026-10-31T00:00:00.000Z",
  };

  it("initializes with idle state", () => {
    expect(INITIAL_AUTH_STATE).toEqual({
      status: "idle",
      user: null,
      error: null,
    });
  });

  it("transitions to authenticating on INIT_START or LOGIN_SUBMIT", () => {
    const s1 = authReducer(INITIAL_AUTH_STATE, { type: "INIT_START" });
    expect(s1.status).toBe("authenticating");
    expect(s1.error).toBeNull();

    const s2 = authReducer({ ...INITIAL_AUTH_STATE, error: "previous error" }, { type: "LOGIN_SUBMIT" });
    expect(s2.status).toBe("authenticating");
    expect(s2.error).toBeNull();
  });

  it("transitions to authenticated on INIT_SUCCESS or LOGIN_SUCCESS", () => {
    const s1 = authReducer(INITIAL_AUTH_STATE, { type: "INIT_SUCCESS", payload: dummyUser });
    expect(s1.status).toBe("authenticated");
    expect(s1.user).toEqual(dummyUser);
    expect(s1.error).toBeNull();

    const s2 = authReducer({ status: "authenticating", user: null, error: null }, {
      type: "LOGIN_SUCCESS",
      payload: dummyUser,
    });
    expect(s2.status).toBe("authenticated");
    expect(s2.user).toEqual(dummyUser);
  });

  it("transitions to unauthenticated on INIT_UNAUTHENTICATED or LOGOUT", () => {
    const authedState: AuthState = { status: "authenticated", user: dummyUser, error: null };
    const s1 = authReducer(authedState, { type: "LOGOUT" });
    expect(s1.status).toBe("unauthenticated");
    expect(s1.user).toBeNull();

    const s2 = authReducer(INITIAL_AUTH_STATE, { type: "INIT_UNAUTHENTICATED" });
    expect(s2.status).toBe("unauthenticated");
    expect(s2.user).toBeNull();
  });

  it("transitions to error on LOGIN_FAILURE", () => {
    const s = authReducer({ status: "authenticating", user: null, error: null }, {
      type: "LOGIN_FAILURE",
      error: "密码错误",
    });
    expect(s.status).toBe("error");
    expect(s.user).toBeNull();
    expect(s.error).toBe("密码错误");
  });

  it("transitions to session_expired on SESSION_EXPIRED", () => {
    const authedState: AuthState = { status: "authenticated", user: dummyUser, error: null };
    const s = authReducer(authedState, { type: "SESSION_EXPIRED" });
    expect(s.status).toBe("session_expired");
    expect(s.user).toBeNull();
    expect(s.error).toBe("登录已失效，请重新登录");
  });
});
