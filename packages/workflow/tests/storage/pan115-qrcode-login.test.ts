import { describe, expect, it } from "vitest";
import {
  Pan115QrLoginClient,
  PAN115_QR_LOGIN_APPS,
  Pan115QrExchangeError,
  isPan115QrExchangeError,
  isTransientPan115NetworkError,
} from "../../src/index.js";

interface RecordedRequest {
  url: string;
  method: string;
  body?: string;
  headers?: Record<string, string>;
}

describe("Pan115QrLoginClient", () => {
  it("gets a QR session token and falls back to the scan URL when qrcode is absent", async () => {
    const requests: RecordedRequest[] = [];
    const client = new Pan115QrLoginClient({
      fetchJson: async (url, init) => {
        requests.push({ url, method: init.method });
        return { state: 1, code: 0, data: { uid: "uid_1", time: 1718000000, sign: "sig" } };
      },
    });

    const session = await client.getToken();

    expect(requests[0]?.url).toBe("https://qrcodeapi.115.com/api/1.0/web/1.0/token/");
    expect(session).toEqual({
      uid: "uid_1",
      time: 1718000000,
      sign: "sig",
      qrcodeContent: "https://115.com/scan/dg-uid_1",
    });
  });

  it("maps poll status codes, treating a missing status field as waiting", async () => {
    const statuses: unknown[] = [
      { data: { status: 0 } },
      { data: { status: 1 } },
      { data: { status: 2 } },
      { data: { status: -1 } },
      { data: { status: -2 } },
      { data: {} }, // long-poll timeout shape
    ];
    let call = 0;
    const client = new Pan115QrLoginClient({
      fetchJson: async (url) => {
        expect(url).toContain("https://qrcodeapi.115.com/get/status/?uid=uid_1&time=1718000000&sign=sig");
        return statuses[call++];
      },
    });
    const session = { uid: "uid_1", time: 1718000000, sign: "sig", qrcodeContent: "x" };

    expect(await client.pollStatus(session)).toBe("waiting");
    expect(await client.pollStatus(session)).toBe("scanned");
    expect(await client.pollStatus(session)).toBe("confirmed");
    expect(await client.pollStatus(session)).toBe("expired");
    expect(await client.pollStatus(session)).toBe("canceled");
    expect(await client.pollStatus(session)).toBe("waiting");
  });

  it("exchanges a confirmed session for a serialized cookie with the chosen app", async () => {
    const requests: RecordedRequest[] = [];
    const client = new Pan115QrLoginClient({
      fetchJson: async (url, init) => {
        requests.push({ url, method: init.method, body: init.body ?? "", headers: init.headers ?? {} });
        return {
          state: 1,
          data: {
            cookie: { UID: "u_R2_1", CID: "c", SEID: "s", KID: "k" },
            user_id: 42,
            user_name: "fancy",
          },
        };
      },
    });

    const result = await client.exchangeCookie(
      { uid: "uid_1", time: 1, sign: "sig", qrcodeContent: "x" },
      "tv",
    );

    expect(requests[0]?.url).toBe(
      "https://qrcodeapi.115.com/app/1.0/tv/1.0/login/qrcode/",
    );
    expect(requests[0]?.body).toBe("account=uid_1&app=tv");
    expect(result).toEqual({
      cookie: "UID=u_R2_1; CID=c; SEID=s; KID=k",
      userId: 42,
      userName: "fancy",
      app: "tv",
    });
  });

  it("automatically probes candidate apps when the preferred app fails (e.g. scanned with wechat)", async () => {
    const attemptedApps: string[] = [];
    const client = new Pan115QrLoginClient({
      fetchJson: async (url) => {
        const match = url.match(/\/app\/1\.0\/([^/]+)\/1\.0\/login\/qrcode\//);
        const app = match?.[1] ?? "";
        attemptedApps.push(app);
        if (app === "alipaymini") {
          return { state: 0, message: "老乡验证失败！", data: {} };
        }
        if (app === "wechatmini") {
          return {
            state: 1,
            data: {
              cookie: { UID: "u_wechat", CID: "c2", SEID: "s2", KID: "k2" },
              user_id: 100,
              user_name: "wechat_user",
            },
          };
        }
        return { state: 0, message: "fail", data: {} };
      },
    });

    const result = await client.exchangeCookie(
      { uid: "uid_1", time: 1, sign: "sig", qrcodeContent: "x" },
      "alipaymini",
    );

    expect(attemptedApps).toEqual(["alipaymini", "tv", "qandroid", "android", "ios", "web", "wechatmini"]);
    expect(result).toEqual({
      cookie: "UID=u_wechat; CID=c2; SEID=s2; KID=k2",
      userId: 100,
      userName: "wechat_user",
      app: "wechatmini",
    });
  });

  it("retries getToken on transient network failure", async () => {
    let attempts = 0;
    const client = new Pan115QrLoginClient({
      fetchJson: async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("transient socket hang up");
        }
        return { state: 1, code: 0, data: { uid: "uid_retry", time: 1718000000, sign: "sig" } };
      },
    });

    const session = await client.getToken();
    expect(attempts).toBe(2);
    expect(session.uid).toBe("uid_retry");
  });

  it("defaults to tv when no app is specified", async () => {
    const requests: RecordedRequest[] = [];
    const client = new Pan115QrLoginClient({
      fetchJson: async (url, init) => {
        requests.push({ url, method: init.method, body: init.body ?? "", headers: init.headers ?? {} });
        return {
          state: 1,
          data: {
            cookie: { UID: "u_I1_1" },
            user_id: 1,
            user_name: "tv_user",
          },
        };
      },
    });

    const result = await client.exchangeCookie({ uid: "uid_tv", time: 1, sign: "sig", qrcodeContent: "" });
    expect(requests[0]?.url).toBe("https://qrcodeapi.115.com/app/1.0/tv/1.0/login/qrcode/");
    expect(requests[0]?.body).toBe("account=uid_tv&app=tv");
    expect(result.app).toBe("tv");
  });

  it("ensures tv is the primary recommended client and qandroid is supported", () => {
    expect(PAN115_QR_LOGIN_APPS[0]).toBe("tv");
    expect(PAN115_QR_LOGIN_APPS).toContain("qandroid");
  });

  it("fails loudly with Pan115QrExchangeError when the exchange returns no cookie or system discontinued", async () => {
    const client = new Pan115QrLoginClient({
      fetchJson: async () => ({ state: 0, error: "登录失败，系统已下架！", errno: 40101017, data: {} }),
    });

    let thrown: unknown;
    try {
      await client.exchangeCookie({ uid: "u", time: 1, sign: "s", qrcodeContent: "x" }, "alipaymini");
    } catch (e) {
      thrown = e;
    }

    expect(isPan115QrExchangeError(thrown)).toBe(true);
    expect((thrown as Pan115QrExchangeError).message).toBe("PAN115_QR_EXCHANGE_FAILED: 登录失败，系统已下架！");
    expect((thrown as Pan115QrExchangeError).code).toBe(40101017);
  });

  it("sends Connection: close in headers to prevent stale socket resets", async () => {
    const requests: RecordedRequest[] = [];
    const client = new Pan115QrLoginClient({
      fetchJson: async (url, init) => {
        requests.push({ url, method: init.method, body: init.body ?? "", headers: init.headers ?? {} });
        return {
          state: 1,
          data: {
            cookie: { UID: "u_tv" },
            user_id: 2,
            user_name: "test",
          },
        };
      },
    });

    await client.exchangeCookie({ uid: "u", time: 1, sign: "s", qrcodeContent: "" }, "tv");
    expect(requests[0]?.headers?.Connection).toBe("close");
  });

  it("continues probing candidates even if an earlier candidate throws a network error", async () => {
    const client = new Pan115QrLoginClient({
      fetchJson: async (url) => {
        if (url.includes("/tv/")) {
          throw new Error("fetch failed (read ECONNRESET)");
        }
        if (url.includes("/qandroid/")) {
          return {
            state: 1,
            data: {
              cookie: { UID: "u_qandroid" },
              user_id: 3,
              user_name: "qandroid_user",
            },
          };
        }
        return { state: 0, message: "not this one", data: {} };
      },
    });

    const result = await client.exchangeCookie({ uid: "u", time: 1, sign: "s", qrcodeContent: "" }, "tv");
    expect(result.app).toBe("qandroid");
    expect(result.userName).toBe("qandroid_user");
  });

  it("identifies transient network reset errors correctly", () => {
    expect(isTransientPan115NetworkError(new Error("fetch failed (read ECONNRESET)"))).toBe(true);
    expect(isTransientPan115NetworkError(new Error("socket hang up"))).toBe(true);
    expect(isTransientPan115NetworkError(new Error("connect ETIMEDOUT"))).toBe(true);
    expect(isTransientPan115NetworkError(new Error("connect ECONNREFUSED"))).toBe(true);
    expect(isTransientPan115NetworkError(new Error("Client network socket disconnected"))).toBe(true);
    expect(isTransientPan115NetworkError(new Error("PAN115_QR_EXCHANGE_FAILED: 老乡验证失败！"))).toBe(false);
  });
});
