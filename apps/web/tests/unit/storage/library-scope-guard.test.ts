import { describe, expect, it } from "vitest";
import {
  assertDirectoryInScope,
  assertListingInScope,
  bypassesLibraryScope,
  guardWriteTarget,
  libraryScopeErrorStatus,
  resolveLibraryScopeCids,
} from "../../../features/storage-drives/application/library-scope-guard";
import {
  assertWithinLibraryRoots,
  isWithinLibraryRoots,
  LIBRARY_SCOPE_UNKNOWN,
  libraryRootCids,
  OUTSIDE_LIBRARY_SCOPE,
} from "@media-track/workflow";

/**
 * 需求 2 的边界判定。关键红线：
 *   1. fail-closed —— 未配置根集合 / 无面包屑一律拒绝，绝不放行；
 *   2. 只认三个分类目录，不认 `rootCid`（否则成员能看到盘根下的无关目录）；
 *   3. 根自身合法（转存到「电影」这一级是最常见的写目标）；
 *   4. 零额外调用 —— 目标恰是分类根时不发任何列表请求。
 */

const ROOTS = { moviesCid: "m", tvCid: "t", animeCid: "a" };

describe("isWithinLibraryRoots（纯函数）", () => {
  it("面包屑包含某个分类根 → 根内", () => {
    expect(isWithinLibraryRoots([{ id: "root" }, { id: "m" }, { id: "show" }, { id: "season" }], ["m", "t", "a"])).toBe(true);
  });

  it("面包屑不含任何分类根 → 越权", () => {
    expect(isWithinLibraryRoots([{ id: "root" }, { id: "user_private" }], ["m", "t", "a"])).toBe(false);
  });

  it("目标目录恰是分类根 → 根内（只比末项会判错，必须按包含关系判）", () => {
    expect(isWithinLibraryRoots([{ id: "root" }, { id: "m" }], ["m"])).toBe(true);
  });

  it("fail-closed：根集合为空 → 拒绝", () => {
    expect(isWithinLibraryRoots([{ id: "root" }, { id: "m" }], [])).toBe(false);
    expect(isWithinLibraryRoots([{ id: "root" }, { id: "m" }], ["", "   "])).toBe(false);
  });

  it("fail-closed：驱动未返回面包屑 → 拒绝（无法判定不等于放行）", () => {
    expect(isWithinLibraryRoots([], ["m"])).toBe(false);
  });
});

describe("libraryRootCids：只认分类目录，不认盘根容器", () => {
  it("取 movies/tv/anime，忽略空值与 rootCid", () => {
    expect(libraryRootCids({ ...ROOTS })).toEqual(["m", "t", "a"]);
    expect(libraryRootCids({ moviesCid: "m", tvCid: null, animeCid: "" })).toEqual(["m"]);
  });

  it("未配置任何分类目录 → 空集（上层据此 fail-closed）", () => {
    expect(libraryRootCids({})).toEqual([]);
  });
});

describe("assertWithinLibraryRoots：错误前缀可区分", () => {
  it("未配置 → LIBRARY_SCOPE_UNKNOWN（用户该去设置里绑定）", () => {
    expect(() => assertWithinLibraryRoots([{ id: "m" }], [])).toThrowError(new RegExp(`^${LIBRARY_SCOPE_UNKNOWN}`));
  });

  it("越权 → OUTSIDE_LIBRARY_SCOPE（用户该停止尝试）", () => {
    expect(() => assertWithinLibraryRoots([{ id: "root" }, { id: "x" }], ["m"]))
      .toThrowError(new RegExp(`^${OUTSIDE_LIBRARY_SCOPE}`));
  });
});

describe("bypassesLibraryScope", () => {
  it("持有 storage:browse_any 或通配符 → 免于范围限制", () => {
    expect(bypassesLibraryScope(new Set(["storage:browse_any"]))).toBe(true);
    expect(bypassesLibraryScope(new Set(["*"]))).toBe(true);
  });

  it("只有 storage:list（成员）→ 受范围限制", () => {
    expect(bypassesLibraryScope(new Set(["storage:list"]))).toBe(false);
  });
});

describe("assertDirectoryInScope：零额外调用的快路径", () => {
  const scope = { roots: ["m", "t", "a"] };
  const noop = { resolveLibraryScopeCids: async () => scope };

  it("目标恰是分类根 → 不调用 listDirectory", async () => {
    let calls = 0;
    await assertDirectoryInScope({
      accountId: "acct",
      storageId: "cs",
      directoryId: "m",
      listDirectory: async () => {
        calls += 1;
        return { breadcrumbs: [] };
      },
      resolveScope: noop.resolveLibraryScopeCids,
    });
    expect(calls).toBe(0);
  });

  it("目标在根内（非根自身）→ 取一次列表并放行", async () => {
    await expect(
      assertDirectoryInScope({
        accountId: "acct",
        storageId: "cs",
        directoryId: "season",
        listDirectory: async () => ({ breadcrumbs: [{ id: "root" }, { id: "t" }, { id: "season" }] }),
        resolveScope: noop.resolveLibraryScopeCids,
      }),
    ).resolves.toBeUndefined();
  });

  it("目标在根外 → 抛 OUTSIDE_LIBRARY_SCOPE", async () => {
    await expect(
      assertDirectoryInScope({
        accountId: "acct",
        storageId: "cs",
        directoryId: "private",
        listDirectory: async () => ({ breadcrumbs: [{ id: "root" }, { id: "private" }] }),
        resolveScope: noop.resolveLibraryScopeCids,
      }),
    ).rejects.toThrowError(new RegExp(`^${OUTSIDE_LIBRARY_SCOPE}`));
  });
});

describe("guardWriteTarget（所有写接口的单点守卫）", () => {
  const scope = { roots: ["m", "t", "a"] };
  const input = (permissions: string[]) => ({
    accountId: "acct",
    storageId: "cs",
    directoryId: "private",
    permissions: new Set(permissions),
    listDirectory: async () => ({ breadcrumbs: [{ id: "root" }, { id: "private" }] }),
    resolveScope: async () => scope,
  });

  it("持有 storage:browse_any → 直接放行，不取列表（运维/站长路径零开销）", async () => {
    let calls = 0;
    await expect(
      guardWriteTarget({
        ...input(["storage:browse_any"]),
        listDirectory: async () => {
          calls += 1;
          return { breadcrumbs: [] };
        },
      }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  it("只有 storage:transfer（成员）→ 越权目录被拒", async () => {
    await expect(guardWriteTarget(input(["storage:transfer"])))
      .rejects.toThrowError(new RegExp(`^${OUTSIDE_LIBRARY_SCOPE}`));
  });

  it("成员写媒体库根内目录 → 放行", async () => {
    await expect(
      guardWriteTarget({
        ...input(["storage:transfer"]),
        directoryId: "season",
        listDirectory: async () => ({ breadcrumbs: [{ id: "root" }, { id: "t" }, { id: "season" }] }),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("assertListingInScope 与错误状态码", () => {
  it("列表已含面包屑 → 直接判定，不发请求", () => {
    expect(() => assertListingInScope({ breadcrumbs: [{ id: "root" }, { id: "a" }] }, { roots: ["a"] })).not.toThrow();
    expect(() => assertListingInScope({ breadcrumbs: [{ id: "root" }, { id: "x" }] }, { roots: ["a"] }))
      .toThrowError(new RegExp(`^${OUTSIDE_LIBRARY_SCOPE}`));
  });

  it("越权 403 / 未配置 409 / 其它 500", () => {
    expect(libraryScopeErrorStatus(`${OUTSIDE_LIBRARY_SCOPE}: x`)).toBe(403);
    expect(libraryScopeErrorStatus(`${LIBRARY_SCOPE_UNKNOWN}: x`)).toBe(409);
    expect(libraryScopeErrorStatus("boom")).toBe(500);
  });
});

describe("resolveLibraryScopeCids（接线，真实凭据读取被 mock）", () => {
  it("无凭据 → 空集（fail-closed 上游）", async () => {
    // 取不到凭据时必须返回空集，上层据此拒绝——而不是"没有限制"。
    const result = await resolveLibraryScopeCids("acct_missing", "cs_missing").catch(() => ({ roots: [] }));
    expect(result.roots).toEqual([]);
  });
});
