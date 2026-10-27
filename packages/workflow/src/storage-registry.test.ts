import { describe, expect, it } from "vitest";
import {
  buildExecutorForBrand,
  createExecutorForBrand,
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
