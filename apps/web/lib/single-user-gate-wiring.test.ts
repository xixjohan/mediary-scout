import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 单用户密码门的**不纯接线**测试。
 *
 * 纯函数（resolveSingleUserAccount / isRemoteRequest）在 single-user-password.test.ts
 * 里已全组合覆盖；真正出事故的是把它们串起来的那段代码——Emby/Jellyfin 的漏洞
 * 都不在判定函数本身，而在「读不到状态时怎么办」。本文件专测这些故障路径：
 *  - DB 读失败时，远程请求必须 fail-closed（不能因为读不到密码状态就当没设密码）
 *  - session 读失败时，已判定为远程的请求必须 fail-closed
 *  - 属于别的账号的有效 session 不得落进单用户路径
 */

const prevSqlitePath = process.env.MEDIA_TRACK_SQLITE_PATH;
const prevMultiUser = process.env.MEDIA_TRACK_MULTI_USER;

const boot = async () => {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  delete process.env.MEDIA_TRACK_MULTI_USER; // 单用户
  vi.resetModules();
  return import("./workflow-runtime");
};

/** 装上一个假的 next/headers，模拟「经隧道的远程请求」。 */
const mockRemoteRequest = (cookieValue?: string) => {
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers({ "cf-ray": "8f3abc-LAX" }),
    cookies: async () => ({
      get: (name: string) =>
        name === "mt_session" && cookieValue ? { name, value: cookieValue } : undefined,
    }),
  }));
};

afterEach(() => {
  delete process.env.MEDIA_TRACK_SQLITE_PATH;
  if (prevSqlitePath !== undefined) process.env.MEDIA_TRACK_SQLITE_PATH = prevSqlitePath;
  if (prevMultiUser !== undefined) {
    process.env.MEDIA_TRACK_MULTI_USER = prevMultiUser;
  } else {
    delete process.env.MEDIA_TRACK_MULTI_USER;
  }
  vi.doUnmock("next/headers");
  vi.resetModules();
});

/**
 * ⚠️ 超时：这些用例会调用 setSingleUserPassword / loginAccount，二者都跑
 * memory-hard 的 scrypt（单次 ~50-80ms）。全量并行下与其它测试争抢 CPU 会远超
 * vitest 默认的 5s。显式放宽到 30s——这不是「慢测试」，是密码学原语的固有成本。
 */
const CRYPTO_TIMEOUT_MS = 30_000;

describe("single-user gate wiring (failure paths)", () => {
  it(
    "远程 + 密码状态读失败 → 必须 fail-closed（不得当作未设密码而放行）",
    async () => {
      mockRemoteRequest();
      const rt = await boot();
      await rt.setSingleUserPassword("secret-123");

      // 让密码状态读不出来（DB 抖动/连接池耗尽/故障切换）
      const repo = rt.getWorkflowRepository();
      const original = repo.getAccountById.bind(repo);
      repo.getAccountById = async () => {
        throw new Error("DB down");
      };

      const accountId = await rt.getCurrentAccountId();
      repo.getAccountById = original;

      // 读不到状态 ≠ 没设密码。远程匿名访客绝不能拿到 acct_default。
      expect(accountId).toBe("acct_unauthenticated");
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "远程 + 密码状态读失败 → 写操作必须抛错",
    async () => {
      mockRemoteRequest();
      const rt = await boot();
      await rt.setSingleUserPassword("secret-123");

      const repo = rt.getWorkflowRepository();
      const original = repo.getAccountById.bind(repo);
      repo.getAccountById = async () => {
        throw new Error("DB down");
      };

      await expect(rt.requireAuthenticatedAccountId()).rejects.toThrow();
      repo.getAccountById = original;
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "远程 + session 读失败 → 已知是远程，必须 fail-closed",
    async () => {
      mockRemoteRequest("forged.cookie");
      const rt = await boot();
      await rt.setSingleUserPassword("secret-123");

      const repo = rt.getWorkflowRepository();
      const original = repo.getSession.bind(repo);
      repo.getSession = async () => {
        throw new Error("session store down");
      };

      const accountId = await rt.getCurrentAccountId();
      repo.getSession = original;

      expect(accountId).toBe("acct_unauthenticated");
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "远程 + 属于别的账号的有效 session → 不得落进单用户路径",
    async () => {
      // 同一个库可能有多用户时期遗留的账号（MEDIA_TRACK_MULTI_USER 是运行时开关，
      // 可以再切回单用户）。那些账号的 session 不该在单用户模式下被认作站主。
      const rt = await boot();
      // 纯函数层面就应该钉死：只有 acct_default 才算数
      expect(
        rt.resolveSingleUserAccount({
          hasPassword: true,
          isRemote: true,
          sessionAccountId: "acct_someone_else",
        }),
      ).toBe("acct_unauthenticated");
      expect(
        rt.resolveSingleUserAccount({
          hasPassword: true,
          isRemote: true,
          sessionAccountId: "acct_default",
        }),
      ).toBe("acct_default");
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "LAN + 密码状态读失败 → 保持开放（不因读不到就把本地用户锁死）",
    async () => {
      vi.doMock("next/headers", () => ({
        headers: async () => new Headers({ "user-agent": "curl" }), // 无 CF 头 = LAN
        cookies: async () => ({ get: () => undefined }),
      }));
      const rt = await boot();
      await rt.setSingleUserPassword("secret-123");

      const repo = rt.getWorkflowRepository();
      const original = repo.getAccountById.bind(repo);
      repo.getAccountById = async () => {
        throw new Error("DB down");
      };

      const accountId = await rt.getCurrentAccountId();
      repo.getAccountById = original;

      // 局域网是可信网段：读不到状态时维持现状行为，不制造运维事故
      expect(accountId).toBe("acct_default");
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "无请求上下文（in-process worker）→ 直通 acct_default",
    async () => {
      const rt = await boot();
      await rt.setSingleUserPassword("secret-123");
      // 未 mock next/headers ⇒ 取不到请求作用域，等同后台任务
      expect(await rt.getCurrentAccountId()).toBe("acct_default");
    },
    CRYPTO_TIMEOUT_MS,
  );
});

/**
 * 「未设密码 ⇒ 远程也全开放」是本仓库最严重的一个洞。
 *
 * 旧实现在判定远程之前就先 `if (hasPassword === false) return acct_default`，
 * 于是一个**匿名公网访客**经隧道进来即拿到站主身份：整个媒体库、五个网盘的
 * 凭据、LLM key 全部可读，且写路径也放行——`requireAuthenticatedAccountId()`
 * 只拦哨兵 `acct_unauthenticated`，而这条路径压根产不出哨兵。
 *
 * 这在 Cloudflare Access 挡在前面时尚可存活；本分支移除了 Access，它就变成
 * 一个活的公网洞。新规则：**远程一律需要 session，与密码状态无关**；
 * 局域网维持开放（既定的可信网段设计）。
 */
describe("未设密码 + 远程 = 必须 fail-closed（移除 Access 后的公网洞）", () => {
  it(
    "纯函数：未设密码 + 远程 + 无 session → 哨兵，绝不是 acct_default",
    async () => {
      const rt = await boot();
      expect(
        rt.resolveSingleUserAccount({ hasPassword: false, isRemote: true, sessionAccountId: null }),
      ).toBe("acct_unauthenticated");
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "纯函数：未设密码 + 局域网 → 保持开放（可信网段设计不变）",
    async () => {
      const rt = await boot();
      expect(
        rt.resolveSingleUserAccount({ hasPassword: false, isRemote: false, sessionAccountId: null }),
      ).toBe("acct_default");
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "纯函数：状态未知/已设密码的既有组合不受影响",
    async () => {
      const rt = await boot();
      // LAN 一律开放
      expect(
        rt.resolveSingleUserAccount({ hasPassword: true, isRemote: false, sessionAccountId: null }),
      ).toBe("acct_default");
      expect(
        rt.resolveSingleUserAccount({ hasPassword: "unknown", isRemote: false, sessionAccountId: null }),
      ).toBe("acct_default");
      // 远程：只认 acct_default 自己的 session
      expect(
        rt.resolveSingleUserAccount({ hasPassword: true, isRemote: true, sessionAccountId: null }),
      ).toBe("acct_unauthenticated");
      expect(
        rt.resolveSingleUserAccount({ hasPassword: "unknown", isRemote: true, sessionAccountId: null }),
      ).toBe("acct_unauthenticated");
      expect(
        rt.resolveSingleUserAccount({ hasPassword: false, isRemote: true, sessionAccountId: "acct_default" }),
      ).toBe("acct_default");
      expect(
        rt.resolveSingleUserAccount({ hasPassword: true, isRemote: true, sessionAccountId: "acct_default" }),
      ).toBe("acct_default");
    },
    CRYPTO_TIMEOUT_MS,
  );

  /**
   * 接线测试，不可省。`getCurrentAccountId()` 自己也有一份
   * `if (hasPassword === false) return DEFAULT_ACCOUNT_ID` 的短路，位置在调用
   * 纯函数**之前**。只修纯函数会让上面那些断言全绿、而真实请求路径依旧裸奔。
   */
  it(
    "接线：未设密码 + 远程匿名请求 → getCurrentAccountId 必须返回哨兵",
    async () => {
      mockRemoteRequest(); // 有 cf-ray，无 session cookie
      const rt = await boot();
      // 刻意不设密码：全新实例的真实状态
      expect(await rt.hasLoginPassword()).toBe(false);
      expect(await rt.getCurrentAccountId()).toBe("acct_unauthenticated");
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "接线：未设密码 + 远程匿名请求 → 写路径必须抛错",
    async () => {
      mockRemoteRequest();
      const rt = await boot();
      expect(await rt.hasLoginPassword()).toBe(false);
      await expect(rt.requireAuthenticatedAccountId()).rejects.toThrow();
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "接线：未设密码 + 局域网 → 仍然直通 acct_default（不得回归）",
    async () => {
      vi.doMock("next/headers", () => ({
        headers: async () => new Headers({ "user-agent": "curl" }), // 无 CF 头 = LAN
        cookies: async () => ({ get: () => undefined }),
      }));
      const rt = await boot();
      expect(await rt.hasLoginPassword()).toBe(false);
      expect(await rt.getCurrentAccountId()).toBe("acct_default");
    },
    CRYPTO_TIMEOUT_MS,
  );
});

/**
 * S5.4 对抗性自审发现的真缺口（mock 掩盖类，同 DEFAULT_ACCOUNT_ID）。
 *
 * 责任链（auth-chain）第 2 通道认 Bearer JWT，可 23 个路由守卫后仍调
 * `getCurrentAccountId()` 取账号作用域——**JWT 解出来的账号被丢掉了**：
 * 多用户模式下无 session cookie 时该函数返回哨兵 `acct_unauthenticated`，
 * 于是「JWT 认证成功」与「拿不到账号」同时成立：账号作用域数据全空、
 * 写路径直接抛错。单用户远程同理（既有的远程必须 fail-closed 语义不变，
 * 但一个验签通过的 JWT 不该被判成匿名）。
 *
 * 真实请求路径的测试，不可省：route-auth.test.ts 的 JWT 用例之所以全绿，
 * 是因为它 mock 掉了 getCurrentAccountId（与掩盖 DEFAULT_ACCOUNT_ID 同一手法）。
 */
describe("Bearer JWT 通道：getCurrentAccountId 必须认（S5.4 自审）", () => {
  const JWT_SECRET = "jwt-bearer-channel-test-secret-32-bytes!";

  /** 多用户 + 指定请求头启动 runtime（JWT secret 走 env，避开 DB）。 */
  const bootMultiUser = async (headers: Record<string, string>) => {
    process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
    process.env.MEDIA_TRACK_MULTI_USER = "1";
    process.env.MEDIA_TRACK_JWT_SECRET = JWT_SECRET;
    vi.doMock("next/headers", () => ({
      headers: async () => new Headers(headers),
      cookies: async () => ({ get: () => undefined }), // 无 session cookie
    }));
    vi.resetModules();
    return import("./workflow-runtime");
  };

  afterEach(() => {
    delete process.env.MEDIA_TRACK_JWT_SECRET;
    delete process.env.MEDIA_TRACK_MULTI_USER;
    if (prevMultiUser !== undefined) process.env.MEDIA_TRACK_MULTI_USER = prevMultiUser;
  });

  it("多用户 + 有效 Bearer JWT → 返回 JWT 里的账号（不是哨兵）", async () => {
    const { issueToken } = await import("@media-track/shared");
    const token = await issueToken({ sub: "acct_jwt_owner" }, JWT_SECRET, 600);
    const rt = await bootMultiUser({ authorization: `Bearer ${token}` });
    expect(await rt.getCurrentAccountId()).toBe("acct_jwt_owner");
  });

  it("多用户 + 篡改的 JWT → 哨兵（fail-closed，不得放行）", async () => {
    const rt = await bootMultiUser({ authorization: "Bearer not.a.real.token" });
    expect(await rt.getCurrentAccountId()).toBe("acct_unauthenticated");
  });

  it("多用户 + 过期 JWT → 哨兵", async () => {
    const { issueToken } = await import("@media-track/shared");
    const token = await issueToken({ sub: "acct_jwt_owner" }, JWT_SECRET, -10);
    const rt = await bootMultiUser({ authorization: `Bearer ${token}` });
    expect(await rt.getCurrentAccountId()).toBe("acct_unauthenticated");
  });

  it("多用户 + 错误 secret 签发的 JWT → 哨兵", async () => {
    const { issueToken } = await import("@media-track/shared");
    const token = await issueToken({ sub: "acct_jwt_owner" }, "another-secret-entirely-32-bytes!!", 600);
    const rt = await bootMultiUser({ authorization: `Bearer ${token}` });
    expect(await rt.getCurrentAccountId()).toBe("acct_unauthenticated");
  });

  it("多用户 + 无任何凭据 → 仍是哨兵（不因新通道放宽）", async () => {
    const rt = await bootMultiUser({ "user-agent": "curl" });
    expect(await rt.getCurrentAccountId()).toBe("acct_unauthenticated");
  });
});

/**
 * L1（逐维核查补缺）：规格列的畸形 Bearer 形态此前只对 auth-chain 测试里的
 * mock 复刻版断言过，**真实** resolveBearerAccountId 一个都没覆盖。
 */
describe("resolveBearerAccountId：畸形形态对真实实现（L1）", () => {
  const REAL_SECRET = "l1-real-secret-32-bytes-xxxxxxxxxx";

  async function resolveReal(authorization: string | undefined): Promise<string | null> {
    process.env.MEDIA_TRACK_MULTI_USER = "1";
    process.env.MEDIA_TRACK_JWT_SECRET = REAL_SECRET;
    vi.resetModules();
    const { resolveBearerAccountId } = await import("./workflow-runtime");
    const headers = new Headers();
    if (authorization !== undefined) headers.set("authorization", authorization);
    return resolveBearerAccountId(headers);
  }

  it("五种畸形形态全部视同无凭据（null）", async () => {
    for (const bad of ["Bearer", "Bearer ", "Basic abc", "Token xyz", "bearer"]) {
      expect(await resolveReal(bad), bad).toBeNull();
    }
  });

  it("无 authorization 头 → null", async () => {
    expect(await resolveReal(undefined)).toBeNull();
  });

  it("大小写混排的 bearer 前缀 + 有效 token → 认（与 scheme 大小写无关）", async () => {
    const { issueToken } = await import("@media-track/shared");
    const token = await issueToken({ sub: "acct_l1" }, REAL_SECRET, 600);
    expect(await resolveReal(`BeArEr ${token}`)).toBe("acct_l1");
  });
});

/**
 * H4（第三轮复核）：单用户远程分支原先只在 `sessionAccountId === null` 时才看
 * Bearer——一枚能解析出别账号的残留 cookie 会让整个 Bearer 通道被跳过，
 * 持合法 acct_default JWT 的站主得到哨兵（200 空数据，而非干净 401）。
 */
describe("单用户远程：残留别账号 cookie 不得吞掉 Bearer 通道（H4）", () => {
  const SECRET = "h4-secret-32-bytes-xxxxxxxxxxxxxxxxxx";
  const prevSessionSecret = process.env.MEDIA_TRACK_SESSION_SECRET;

  afterEach(() => {
    delete process.env.MEDIA_TRACK_JWT_SECRET;
    delete process.env.MEDIA_TRACK_SESSION_SECRET;
    delete process.env.MEDIA_TRACK_MULTI_USER;
    delete process.env.MEDIA_TRACK_SQLITE_PATH;
    if (prevSessionSecret !== undefined) process.env.MEDIA_TRACK_SESSION_SECRET = prevSessionSecret;
    vi.resetModules();
    vi.doUnmock("next/headers");
  });

  /**
   * 单用户 + 远程。用真实的 createLoginSession 造一枚能解析出
   * `leftoverAccountId` 的合法 cookie（不 mock 模块内部调用——自引用 mock 拦不住
   * 函数体内的本地引用，只会让测试假装通过）。
   */
  async function boot(opts: { leftoverAccountId: string | null; authorization?: string }) {
    process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
    delete process.env.MEDIA_TRACK_MULTI_USER; // 单用户
    process.env.MEDIA_TRACK_JWT_SECRET = SECRET;
    process.env.MEDIA_TRACK_SESSION_SECRET = SECRET;
    vi.resetModules();

    const rt = await import("./workflow-runtime");
    let cookie: string | undefined;
    if (opts.leftoverAccountId !== null) {
      // 用真实注册出口造一枚能解析出该账号的合法 cookie（registerAccount 内部
      // createLoginSession 落库 + 签名）。默认账号则用 loginAccount 的 adopt 分支。
      if (opts.leftoverAccountId === "acct_default") {
        // 单用户登录只认 acct_default 且必须已设密码
        expect((await rt.setSingleUserPassword("pw-1234567890")).ok).toBe(true);
        const outcome = await rt.loginAccount("owner", "pw-1234567890");
        cookie = outcome.ok ? outcome.signedCookie : undefined;
      } else {
        const outcome = await rt.registerAccount("leftover-user", "pw-1234567890");
        cookie = outcome.ok ? outcome.signedCookie : undefined;
      }
      expect(cookie, "必须造出合法 session cookie").toBeTruthy();
    }
    const hdrs = new Headers({ "cf-ray": "h4-probe" });
    if (cookie) hdrs.set("cookie", `${rt.SESSION_COOKIE_NAME}=${cookie}`);
    if (opts.authorization !== undefined) hdrs.set("authorization", opts.authorization);
    vi.doMock("next/headers", () => ({
      cookies: async () => ({
        get: (k: string) => (k === rt.SESSION_COOKIE_NAME && cookie ? { value: cookie } : undefined),
      }),
      headers: async () => hdrs,
    }));
    // createLoginSession 已在上面用真实仓库落过库；这里只为隔离重取模块。
    vi.resetModules();
    return import("./workflow-runtime");
  }

  it("残留别账号 session + 有效 acct_default JWT → 默认账号（Bearer 不被跳过）", async () => {
    const { issueToken } = await import("@media-track/shared");
    const token = `Bearer ${await issueToken({ sub: "acct_default" }, SECRET, 600)}`;
    const rt = await boot({ leftoverAccountId: "acct_somebody_else", authorization: token });
    expect(await rt.getCurrentAccountId()).toBe("acct_default");
  });

  it("残留别账号 session + 无 Bearer → 哨兵（既不开放也不认别账号）", async () => {
    const rt = await boot({ leftoverAccountId: "acct_somebody_else" });
    expect(await rt.getCurrentAccountId()).toBe("acct_unauthenticated");
  });

  it("默认账号 session + 有效 JWT → 默认账号（两条路同一答案）", async () => {
    const { issueToken } = await import("@media-track/shared");
    const token = `Bearer ${await issueToken({ sub: "acct_default" }, SECRET, 600)}`;
    const rt = await boot({ leftoverAccountId: "acct_default", authorization: token });
    expect(await rt.getCurrentAccountId()).toBe("acct_default");
  });
});
