import { describe, expect, it } from "vitest";
import { STORAGE_BRANDS } from "@media-track/workflow";
import { STORAGE_PROBES } from "./workflow-runtime";

/**
 * 探活表必须对每个已登记品牌都有条目。
 *
 * 表用 `Record<StorageProvider, …>` 声明，往联合类型里加一家网盘而漏掉探活是
 * **编译错误**——这是主要防线。这条运行时断言守住另一半：DB 里出现一个注册表
 * 认识、但这张表因为笔误/动态改动而缺掉的 provider（编译期查不出的情况，比如
 * 表被 Object.assign 扩充过）。
 */
describe("STORAGE_PROBES 覆盖每个已登记品牌", () => {
  it("注册表里每个 provider 都在探活表里", () => {
    for (const brand of STORAGE_BRANDS) {
      expect(
        typeof STORAGE_PROBES[brand.provider],
        `${brand.provider} 登记了却没接探活`,
      ).toBe("function");
    }
  });

  it("探活表没有多余条目（不留下死代码）", () => {
    const registered = new Set(STORAGE_BRANDS.map((b) => b.provider));
    const orphans = Object.keys(STORAGE_PROBES).filter((p) => !registered.has(p as never));
    expect(orphans, `探活表里有注册表不认识的品牌：${orphans.join(", ")}`).toEqual([]);
  });
});
