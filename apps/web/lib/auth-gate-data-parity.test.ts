import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { issueToken } from "@media-track/shared";
import { proxy } from "../proxy";
import { parseBearerToken } from "./bearer-scheme";

/**
 * 闸机 vs 数据层一致性（第五轮逐维复核的实证件）：把同一请求头在四层上的
 * 判定并排跑出来——
 *   1. proxy（Edge 粗筛）      —— redirect 还是 next
 *   2. parseBearerToken（路由层唯一规则）
 *   3. resolveBearerAccountId（真实 JWT 解账号）
 *   4. resolveApiAccount（闸机） vs getCurrentAccountId（数据层）—— 必须同账号
 *
 * 两个实测前提（本探针自己踩出来的，写下来免得后人再踩）：
 *   · Headers 会按 fetch 规范剥掉头值首尾的 HTTP 空白（空格/tab/CR/LF）——
 *     "Bearer " 上线后两层看到的都是 "Bearer"，raw string 上的分裂在真实
 *     请求里不可达。故矩阵一律走 `new Headers(...).get()` 拿归一化值。
 *   · :memory: SQLite 随 vi.resetModules() 重建，session 行会消失——cookie
 *     必须在**最后一次** boot 之后、用同一个模块实例创建。
 *
 * 不变式（闸机与数据层必须同账号）原先有一处实路径违反：session 解析**抛错**
 * （DB 抖动）+ 有效 Bearer —— 闸机按 auth-chain 的契约继续问 Bearer 拿到账号，
 * 数据层却被 catch 吞成哨兵，症状是「JWT 认证成功却 200 空数据」而非干净 401。
 * 修复（workflow-runtime 两处 catch 改为落 Bearer 兜底）后，这里钉住同账号。
 */

const JWT_SECRET = "probe-jwt-secret-32-bytes-xxxxxxxxxx";
const SESSION_SECRET = "probe-session-secret-32-bytes-xxxxx";
const JWT_SUB = "acct_probe_jwt";

type Boot = {
  rt: typeof import("./workflow-runtime");
  chain: typeof import("./auth-chain");
};

async function boot(
  headers: Record<string, string>,
  opts: { cookieRef?: { value?: string }; multiUser?: boolean } = {},
): Promise<Boot> {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  process.env.MEDIA_TRACK_MULTI_USER = opts.multiUser === false ? "0" : "1";
  process.env.MEDIA_TRACK_JWT_SECRET = JWT_SECRET;
  process.env.MEDIA_TRACK_SESSION_SECRET = SESSION_SECRET;
  const cookieRef = opts.cookieRef;
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers(headers),
    cookies: async () => ({
      get: (k: string) => (k === "mt_session" && cookieRef?.value ? { value: cookieRef.value } : undefined),
    }),
  }));
  vi.resetModules();
  const rt = await import("./workflow-runtime");
  const chain = await import("./auth-chain");
  return { rt, chain };
}

const req = (headers: Record<string, string>): NextRequest =>
  new NextRequest("http://localhost:3000/api/activity", { method: "GET", headers });

const proxyVerdict = (r: NextRequest): "pass" | "redirect" => {
  const res = proxy(r);
  return res.status >= 300 && res.status < 400 ? "redirect" : "pass";
};

/** 头值上线后的真实样子（fetch 规范的首尾 HTTP 空白剥离）。 */
const onWire = (raw: string | null): string | null =>
  raw === null ? null : new Headers({ authorization: raw }).get("authorization");

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("next/headers");
  delete process.env.MEDIA_TRACK_MULTI_USER;
  delete process.env.MEDIA_TRACK_JWT_SECRET;
  delete process.env.MEDIA_TRACK_SESSION_SECRET;
  delete process.env.MEDIA_TRACK_SQLITE_PATH;
});

describe("Bearer 形态矩阵 —— proxy 粗筛 vs 路由层精判（同一请求头）", () => {
  let jwt = "";

  beforeEach(async () => {
    jwt = await issueToken({ sub: JWT_SUB }, JWT_SECRET, 600);
  });

  // label + raw 头值；jwt 在 beforeEach 里现签，故必须是函数
  const forms = (): Array<[string, string | null]> => [
    ["Bearer <jwt>", `Bearer ${jwt}`],
    ["bearer <jwt>", `bearer ${jwt}`],
    ["BeArEr <jwt>", `BeArEr ${jwt}`],
    ["BEARER <jwt>", `BEARER ${jwt}`],
    ["Bearer  <jwt>（两空格）", `Bearer  ${jwt}`],
    ["Bearer\\t<jwt>（tab）", `Bearer\t${jwt}`],
    ["Bearer \\t <jwt>（空格+tab）", `Bearer \t ${jwt}`],
    ["Bearer <jwt>   （尾部空白）", `Bearer ${jwt}   `],
    ["Bearer（无 token）", "Bearer"],
    ["Bearer  （尾部空格）", "Bearer "],
    ["Bearer\\t（仅 tab）", "Bearer\t"],
    [" Bearer <jwt>（前导空白）", ` Bearer ${jwt}`],
    ["Bearer\\u00a0（NBSP token）", "Bearer\u00a0"],
    ["Basic <jwt>", `Basic ${jwt}`],
    ["Token <jwt>", `Token ${jwt}`],
    ["（无 Authorization 头）", null],
  ];

  it("矩阵逐行：proxy / parseBearerToken / resolveBearerAccountId / 闸机 / 数据层", async () => {
    const rows: string[] = [];
    for (const [label, raw] of forms()) {
      const headers: Record<string, string> = { "cf-ray": "probe-ray" }; // 远程 → proxy 门禁生效
      const wire = onWire(raw);
      if (wire !== null) headers.authorization = wire;

      const p = proxyVerdict(req(headers));
      const token = parseBearerToken(wire);

      const { rt, chain } = await boot(headers);
      const bearerAccount = await rt.resolveBearerAccountId(new Headers(headers));
      const gate = await chain.resolveApiAccount(req(headers));
      const data = await rt.getCurrentAccountId();

      rows.push(
        [
          label.padEnd(28),
          `proxy=${p}`.padEnd(14),
          `token=${token === null ? "null" : token === jwt ? "ok" : JSON.stringify(token)}`.padEnd(18),
          `bearerAcct=${bearerAccount ?? "null"}`.padEnd(24),
          `gate=${gate ?? "null"}`.padEnd(22),
          `data=${data}`,
        ].join(" "),
      );
    }
    console.log("\n=== 探针 A 矩阵（多用户 + 远程 cf-ray，/api/activity；头值已按 fetch 规范归一化）===");
    for (const r of rows) console.log(r);
    expect(rows.length).toBe(forms().length);
  });

  it("不变式 1：路由层认得的头，proxy 绝不拦（不存在「proxy 拦死、路由能认」）", async () => {
    for (const [, raw] of forms()) {
      const wire = onWire(raw);
      if (wire === null) continue;
      const token = parseBearerToken(wire);
      const headers: Record<string, string> = { "cf-ray": "probe-ray", authorization: wire };
      const p = proxyVerdict(req(headers));
      if (token !== null) {
        expect(p, `proxy 拦死了路由层认得的头: ${JSON.stringify(wire)}`).toBe("pass");
      }
    }
  });

  it("不变式 2：proxy 放行而路由不认的分裂形态（presence 粗筛的设计方向）", async () => {
    const splits: string[] = [];
    for (const [, raw] of forms()) {
      const wire = onWire(raw);
      if (wire === null) continue;
      const token = parseBearerToken(wire);
      const headers: Record<string, string> = { "cf-ray": "probe-ray", authorization: wire };
      const p = proxyVerdict(req(headers));
      if (p === "pass" && token === null) splits.push(JSON.stringify(wire));
    }
    console.log(
      "proxy 放行 / 路由 null 的分裂形态:",
      splits.map((v) => [...v].map((c) => c.codePointAt(0)!.toString(16)).join(" ")),
    );
    // 只剩 NBSP 这类「\\s 认得、HTTP 空白剥离不掉、trim() 后为空」的 token：
    // 粗筛放行 → 路由 401，方向安全（presence 宽于权威）。「Bearer / Bearer 」
    // 经 Headers 归一化后已不含空白，proxy 自己就拦下了。
    expect(splits).toEqual(['"Bearer\u00a0"']);
  });

  it("不变式 3：换行符头值在 Headers 构造期就被拒（HTTP 层不可达，正则分歧无实际影响）", () => {
    let thrown = false;
    try {
      new Headers({ authorization: `Bearer\n${jwt}` });
    } catch {
      thrown = true;
    }
    console.log("new Headers({authorization: 'Bearer\\n<jwt>'}) 抛错:", thrown);
    expect(thrown).toBe(true);
  });

  it("不变式 4：每个形态下闸机与数据层同账号（无「闸机放行 A、数据层读 B」）", async () => {
    for (const [, raw] of forms()) {
      const wire = onWire(raw);
      const headers: Record<string, string> = { "cf-ray": "probe-ray" };
      if (wire !== null) headers.authorization = wire;
      const { rt, chain } = await boot(headers);
      const gate = await chain.resolveApiAccount(req(headers));
      const data = await rt.getCurrentAccountId();
      expect(
        gate === null ? data === "acct_unauthenticated" : gate === data,
        `形态 ${JSON.stringify(wire)}: gate=${gate} data=${data}`,
      ).toBe(true);
    }
  });
});

describe("session 优先 / Bearer 兜底 —— 闸机与数据层并排", () => {
  it("多用户：有效 session(A) + 有效 Bearer(B) → 两层都取 A（session 优先）", async () => {
    const jwtB = await issueToken({ sub: "acct_jwt_B" }, JWT_SECRET, 600);
    const cookieRef: { value?: string } = {};
    const { rt, chain } = await boot({ authorization: `Bearer ${jwtB}` }, { cookieRef });
    // cookie 必须在最后一次 boot 之后造（:memory: 库随 resetModules 重建）
    cookieRef.value = await rt.createLoginSession("acct_session_A");
    const headers = { authorization: `Bearer ${jwtB}`, cookie: `mt_session=${cookieRef.value}` };
    const gate = await chain.resolveApiAccount(req(headers));
    const data = await rt.getCurrentAccountId();
    expect(gate).toBe("acct_session_A");
    expect(data).toBe("acct_session_A");
  });

  it("多用户：无效 cookie + 有效 Bearer → 两层都取 Bearer 账号（cookie 不得吞掉通道）", async () => {
    const jwtB = await issueToken({ sub: "acct_jwt_B" }, JWT_SECRET, 600);
    const cookieRef: { value?: string } = { value: "garbage.sig" };
    const { rt, chain } = await boot({ authorization: `Bearer ${jwtB}` }, { cookieRef });
    const headers = { authorization: `Bearer ${jwtB}`, cookie: "mt_session=garbage.sig" };
    const gate = await chain.resolveApiAccount(req(headers));
    const data = await rt.getCurrentAccountId();
    expect(gate).toBe("acct_jwt_B");
    expect(data).toBe("acct_jwt_B");
  });

  it("多用户：session 解析抛错（DB 抖动）+ 有效 Bearer → 两层都取 Bearer 账号", async () => {
    const jwtB = await issueToken({ sub: "acct_jwt_B" }, JWT_SECRET, 600);
    const cookieRef: { value?: string } = {};
    const { rt, chain } = await boot({ authorization: `Bearer ${jwtB}` }, { cookieRef });
    cookieRef.value = await rt.createLoginSession("acct_session_A");
    const headers = { authorization: `Bearer ${jwtB}`, cookie: `mt_session=${cookieRef.value}` };
    vi.spyOn(rt.getWorkflowRepository(), "getSession").mockRejectedValue(new Error("db down"));
    const gate = await chain.resolveApiAccount(req(headers));
    const data = await rt.getCurrentAccountId();
    expect(gate).toBe("acct_jwt_B");
    expect(data).toBe("acct_jwt_B");
  });

  it("单用户远程：残留别账号 cookie + 有效默认账号 Bearer → 两层都取默认账号", async () => {
    const jwt = await issueToken({ sub: "acct_default" }, JWT_SECRET, 600);
    const cookieRef: { value?: string } = {};
    const { rt, chain } = await boot({ authorization: `Bearer ${jwt}`, "cf-ray": "probe-ray" }, { multiUser: false, cookieRef });
    cookieRef.value = await rt.createLoginSession("acct_leftover");
    const headers = { authorization: `Bearer ${jwt}`, cookie: `mt_session=${cookieRef.value}`, "cf-ray": "probe-ray" };
    const gate = await chain.resolveApiAccount(req(headers));
    const data = await rt.getCurrentAccountId();
    expect(gate).toBe("acct_default");
    expect(data).toBe("acct_default");
  });

  it("单用户远程：残留别账号 cookie + 无 Bearer → 闸机 null、数据层哨兵", async () => {
    const cookieRef: { value?: string } = {};
    const { rt, chain } = await boot({ "cf-ray": "probe-ray" }, { multiUser: false, cookieRef });
    cookieRef.value = await rt.createLoginSession("acct_leftover");
    const headers = { cookie: `mt_session=${cookieRef.value}`, "cf-ray": "probe-ray" };
    const gate = await chain.resolveApiAccount(req(headers));
    const data = await rt.getCurrentAccountId();
    expect(gate).toBeNull();
    expect(data).toBe("acct_unauthenticated");
  });

  it("单用户远程：有效默认账号 session + 别账号 Bearer → 两层都取默认账号（Bearer 不覆盖 session）", async () => {
    const jwtOther = await issueToken({ sub: "acct_other" }, JWT_SECRET, 600);
    const cookieRef: { value?: string } = {};
    const { rt, chain } = await boot({ authorization: `Bearer ${jwtOther}`, "cf-ray": "probe-ray" }, { multiUser: false, cookieRef });
    cookieRef.value = await rt.createLoginSession("acct_default");
    const headers = { authorization: `Bearer ${jwtOther}`, cookie: `mt_session=${cookieRef.value}`, "cf-ray": "probe-ray" };
    const gate = await chain.resolveApiAccount(req(headers));
    const data = await rt.getCurrentAccountId();
    expect(gate).toBe("acct_default");
    expect(data).toBe("acct_default");
  });

  it("单用户远程：session 解析抛错（DB 抖动）+ 有效默认账号 Bearer → 两层都取默认账号", async () => {
    const jwt = await issueToken({ sub: "acct_default" }, JWT_SECRET, 600);
    const cookieRef: { value?: string } = {};
    const { rt, chain } = await boot({ authorization: `Bearer ${jwt}`, "cf-ray": "probe-ray" }, { multiUser: false, cookieRef });
    cookieRef.value = await rt.createLoginSession("acct_default");
    const headers = { authorization: `Bearer ${jwt}`, cookie: `mt_session=${cookieRef.value}`, "cf-ray": "probe-ray" };
    vi.spyOn(rt.getWorkflowRepository(), "getSession").mockRejectedValue(new Error("db down"));
    const gate = await chain.resolveApiAccount(req(headers));
    const data = await rt.getCurrentAccountId();
    expect(gate).toBe("acct_default");
    expect(data).toBe("acct_default");
  });

  it("单用户局域网：别账号 session + 别账号 Bearer → 两层都取默认账号（LAN 开放语义不被凭据改变）", async () => {
    const jwtOther = await issueToken({ sub: "acct_other" }, JWT_SECRET, 600);
    const cookieRef: { value?: string } = {};
    const { rt, chain } = await boot({ authorization: `Bearer ${jwtOther}` }, { multiUser: false, cookieRef });
    cookieRef.value = await rt.createLoginSession("acct_other");
    const headers = { authorization: `Bearer ${jwtOther}`, cookie: `mt_session=${cookieRef.value}` };
    const gate = await chain.resolveApiAccount(req(headers));
    const data = await rt.getCurrentAccountId();
    expect(gate).toBe("acct_default");
    expect(data).toBe("acct_default");
  });
});
