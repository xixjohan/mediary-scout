import { describe, expect, it } from "vitest";
import {
  buildBootstrapExecutorForBrand,
  buildExecutorForBrand,
  createExecutorForBrand,
  getStorageSkill,
  STORAGE_BRANDS,
  type StorageBrand,
  type StorageDriverCreateInput,
} from "../src/index.js";

/**
 * 单一注册表：品牌元数据与 executor 构造必须在同一张表里。
 *
 * 拆分时期的坑：STORAGE_BRANDS（数据）在 storage-brands.ts，executor 构造
 * （5 个 if 分支）在 storage-executor-factory.ts。加一家网盘要改两处且**没有
 * 编译期保证它们同步**——只在 STORAGE_BRANDS 加条目、忘记接 factory 分支，
 * 要到运行时才炸。合并后「加一家网盘 = 加一个条目」，`create` 是必填字段。
 */

/** A credential blob that satisfies every token brand (and is ignored by cookie brands). */
const ANY_CREDENTIAL = { token: "TK", accessToken: "AT", refreshToken: "RT", sessionKey: "SK" };

describe("STORAGE_BRANDS 是自洽的单一注册表", () => {
  it("每个已登记品牌都带 create（加一家网盘 = 加一个条目）", () => {
    for (const brand of STORAGE_BRANDS) {
      expect(typeof brand.create, `${brand.provider} 登记了却没接 executor`).toBe("function");
    }
  });

  it("每个品牌的 create 都能产出可用 executor", () => {
    for (const brand of STORAGE_BRANDS) {
      const input: StorageDriverCreateInput = {
        provider: brand.provider,
        cookie: "UID=1_A1_2;CID=2;SEID=3;__uid=1",
        credential: ANY_CREDENTIAL,
        scopeCids: ["scope-root"],
        env: {},
      };
      const executor = brand.create(input);
      // removeDirectory 在每个品牌的 executor 上都有；半接线的条目会缺整个端口，
      // 而不是在某个具体调用上才失败。
      expect(typeof executor.removeDirectory, `${brand.provider} create 产出的不是 executor`).toBe("function");
    }
  });

  it("已登记但 create 缺失 → 抛错，不静默降级", () => {
    // TS 让漏接 create 成为编译错误；这条守住绕过类型的路径（JS 调用方、as 断言）。
    const broken = { provider: "pan115", label: "115 网盘" } as unknown as StorageBrand;
    expect(() => buildExecutorForBrand(broken, { provider: "pan115", scopeCids: [] })).toThrowError(
      /without an executor/i,
    );
  });
});

/**
 * 品牌的死链/转存手册也必须在注册表里。
 *
 * getStorageSkill() 原是五个 `if (provider === ...)` 分支加末尾 throw——加一家
 * 网盘漏掉它，agent 就会读到别家盘的转存说明（115 秒传 vs 夸克转存分享链是不同
 * 模型，用错等于让 agent 按错误的步骤操作网盘）。
 */
describe("STORAGE_BRANDS 的死链手册也在注册表里", () => {
  it("每个已登记品牌都带一段非空手册", () => {
    for (const brand of STORAGE_BRANDS) {
      expect(typeof brand.deadLinksSkill, `${brand.provider} 登记了却没带手册`).toBe("string");
      expect(brand.deadLinksSkill.length, `${brand.provider} 的手册是空的`).toBeGreaterThan(0);
    }
  });

  it("getStorageSkill(provider) 返回该品牌自己的手册", () => {
    for (const brand of STORAGE_BRANDS) {
      // 两条一起才不是假绿：光有 `=== brand.deadLinksSkill` 会在两边都是 undefined
      // 时通过（循环依赖就会造成那种状态）。
      expect(getStorageSkill(brand.provider), `${brand.provider} 取不到手册`).toBe(brand.deadLinksSkill);
      expect(getStorageSkill(brand.provider).length, `${brand.provider} 手册为空`).toBeGreaterThan(0);
    }
  });

  it("各家手册互不相同（复制粘贴错一本 = 让 agent 按别家盘的步骤操作）", () => {
    const seen = new Map<string, string>();
    for (const brand of STORAGE_BRANDS) {
      const prior = seen.get(brand.deadLinksSkill);
      expect(prior, `${brand.provider} 与 ${prior} 用了同一本手册`).toBeUndefined();
      seen.set(brand.deadLinksSkill, brand.provider);
    }
  });

  it("未登记的 provider → 抛错，不静默落到别家手册上", () => {
    expect(() => getStorageSkill("nope")).toThrowError(/unknown storage brand/i);
  });
});

/**
 * 建目录树用的 bootstrap executor 也必须在注册表里。
 *
 * provisionDriveCategoryDirs 的尾部原是 `provider === "quark" ? 注册表 : 115 bootstrap`。
 * 加第六家 cookie 盘时，这个三元会把它**静默送进 115 的 executor**——用别家盘的
 * client 去建目录。正是 G1 那类静默失败。
 *
 * `create` 建的是「已绑定了 provisioned CIDs 的稳态 executor」；一块新盘还没有
 * scope（scope 本该从这些目录里来），所以 bootstrap 必须另给一个不受限的变体。
 * 这个区别是品牌自己的知识，故必填。
 */
describe("STORAGE_BRANDS 的 bootstrap executor 也在注册表里", () => {
  it("每个已登记品牌都带 createBootstrap", () => {
    for (const brand of STORAGE_BRANDS) {
      expect(typeof brand.createBootstrap, `${brand.provider} 登记了却没接 bootstrap`).toBe("function");
    }
  });

  it("每个品牌的 createBootstrap 都能产出可用 executor", () => {
    for (const brand of STORAGE_BRANDS) {
      const executor = brand.createBootstrap({
        cookie: "UID=1_A1_2;CID=2;SEID=3;__uid=1",
        credential: ANY_CREDENTIAL,
        env: {},
      });
      expect(typeof executor.createDirectory, `${brand.provider} 的 bootstrap 产出的不是 executor`).toBe(
        "function",
      );
    }
  });

  it("已登记但 createBootstrap 缺失 → 抛错，不静默落到别家 executor 上", () => {
    const broken = { provider: "pan115", label: "115 网盘" } as unknown as StorageBrand;
    expect(() => buildBootstrapExecutorForBrand(broken, { cookie: "", env: {} })).toThrowError(
      /without a bootstrap/i,
    );
  });
});
