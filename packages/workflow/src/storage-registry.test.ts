import { describe, expect, it } from "vitest";
import {
  buildBootstrapExecutorForBrand,
  buildExecutorForBrand,
  createExecutorForBrand,
  transferModelLine,
  getStorageSkill,
  brandSupportsProwlarr,
  brandSupportsSubtitleDirectLink,
  brandsSupportingProwlarr,
  brandsSupportingSubtitleDirectLink,
  STORAGE_BRANDS,
  type StorageBrand,
  type StorageDriverCreateInput,
  type StorageProvider,
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

/**
 * 转存模型提示词也必须在注册表里。
 *
 * transferModelLine 原是四个 `if (provider === ...)` 分支加一个静默的
 * `return ""` 默认值。漏掉一家的后果不是报错，而是**agent 完全不知道这块盘能落
 * 什么链接**（磁力行不行、死链怎么报错）——比没有提示更危险。
 */
describe("STORAGE_BRANDS 的转存模型提示词也在注册表里", () => {
  it("每个已登记品牌都有这个字段（115 为显式空串）", () => {
    for (const brand of STORAGE_BRANDS) {
      expect(typeof brand.transferModelNote, `${brand.provider} 缺 transferModelNote`).toBe("string");
    }
  });

  it("除 115 外每家都真的有内容（静默空串 = agent 不知道能落什么）", () => {
    for (const brand of STORAGE_BRANDS) {
      if (brand.provider === "pan115") {
        expect(brand.transferModelNote, "115 靠 prompt 内既有指引，应为空").toBe("");
        continue;
      }
      expect(brand.transferModelNote.length, `${brand.provider} 的提示词是空的`).toBeGreaterThan(0);
    }
  });

  it("transferModelLine(provider) 返回该品牌自己的提示词", () => {
    for (const brand of STORAGE_BRANDS) {
      expect(transferModelLine({ storageProvider: brand.provider })).toBe(brand.transferModelNote);
    }
  });

  it("storageProvider 缺省 → 115 → 空串（与旧默认行为一致）", () => {
    expect(transferModelLine({})).toBe("");
    expect(transferModelLine({ storageProvider: "pan115" })).toBe("");
  });

  it("各家提示词互不相同", () => {
    const seen = new Map<string, string>();
    for (const brand of STORAGE_BRANDS) {
      if (brand.transferModelNote === "") continue;
      const prior = seen.get(brand.transferModelNote);
      expect(prior, `${brand.provider} 与 ${prior} 用了同一段提示词`).toBeUndefined();
      seen.set(brand.transferModelNote, brand.provider);
    }
  });
});

/**
 * 编译期：STORAGE_BRANDS 的 provider 集合必须**恰好**等于 StorageProvider 联合。
 *
 * 其余断言都是「遍历 STORAGE_BRANDS，检查每家都有 X」——那种写法查不出「联合里
 * 加了品牌但忘了加条目」：数组里没有它，循环自然不会访问它。两个方向的 extends
 * 断言把这类遗漏变成编译错误：
 *   - StorageProvider extends 条目provider联合 → 联合里没有孤儿
 *   - 条目provider联合 extends StorageProvider → 数组里没有越界值
 */
describe("STORAGE_BRANDS 与 StorageProvider 联合严格对应", () => {
  it("联合里没有没进注册表的品牌，注册表里没有联合外的品牌", () => {
    type BrandProviders = (typeof STORAGE_BRANDS)[number]["provider"];
    const unionCovered: StorageProvider extends BrandProviders ? true : never = true;
    const noExtras: BrandProviders extends StorageProvider ? true : never = true;
    expect([unionCovered, noExtras]).toEqual([true, true]);
  });

  it("没有重复 provider（重复条目会让 getStorageBrand 随机命中一个）", () => {
    const providers = STORAGE_BRANDS.map((b) => b.provider);
    expect(new Set(providers).size, `重复 provider：${providers.join(", ")}`).toBe(providers.length);
  });
});

/**
 * W5 网盘管理统一合同：**能力声明必须与 executor 的真实实现一致**。
 *
 * 声明放在注册表条目里（plan：「能力声明就放在注册表条目里，一处定义、前后端共用」），
 * orchestrator 与设置页都读它，而不是各自 `typeof executor.transferSubtitleUrl === "function"`
 * 或在文案里硬编码品牌名单。
 *
 * 这条断言是防漂移的钉子，两个方向都要红：
 *   · 声明支持但 executor 没实现 → agent 拿到一个必然失败的工具，用户看到能用却不能用；
 *   · executor 实现了但没声明 → 设置页把它列进不支持，用户白白少一个能用功能
 *     （字幕设置页此前正是硬编码「115 / 光鸭 / 123」，加第六家时不会有人想起改那句话）。
 *
 * 为什么不用鸭子类型代替声明：鸭子类型只有拿到 executor 才知道，而设置页渲染时并没有
 * executor——它只有 provider 字符串。声明是唯一能在前后端共用、且不需要构造网盘连接的形式。
 */
describe("STORAGE_BRANDS 的能力声明与 executor 实现一致", () => {
  it("**声明支持字幕直链落盘的品牌，executor 真的实现了 transferSubtitleUrl**", () => {
    for (const brand of STORAGE_BRANDS) {
      const executor = brand.create({
        provider: brand.provider,
        cookie: "UID=1_A1_2;CID=2;SEID=3;__uid=1",
        credential: ANY_CREDENTIAL,
        scopeCids: ["scope-root"],
        env: {},
      });
      const declared = brand.supportsSubtitleDirectLink;
      // transferSubtitleUrl 是可选方法，联合类型上不可见——按名字问出来，正是鸭子类型
      // 本身在做的事。这里刻意用鸭子类型去验声明，而不是反过来：声明必须解释现实。
      const implemented =
        typeof (executor as { transferSubtitleUrl?: unknown }).transferSubtitleUrl === "function";
      expect(
        implemented,
        `${brand.provider} 声明 supportsSubtitleDirectLink=${String(declared)}，但 executor ${implemented ? "实现了" : "没实现"} transferSubtitleUrl`,
      ).toBe(declared);
    }
  });

  it("**每家都显式声明**（漏声明的条目 = 前端把它当成不支持，静默少一个功能）", () => {
    for (const brand of STORAGE_BRANDS) {
      expect(typeof brand.supportsSubtitleDirectLink, `${brand.provider} 没声明 supportsSubtitleDirectLink`).toBe("boolean");
    }
  });

  it("**按 provider 查得到的声明与条目一致**（前端只有 provider 字符串）", () => {
    for (const brand of STORAGE_BRANDS) {
      expect(brandSupportsSubtitleDirectLink(brand.provider)).toBe(brand.supportsSubtitleDirectLink);
    }
  });

  it("**未登记的 provider 视为不支持**（不抛错：设置页会拿未知值来问）", () => {
    expect(brandSupportsSubtitleDirectLink("nope")).toBe(false);
    expect(brandSupportsSubtitleDirectLink(undefined)).toBe(false);
  });

  it("**两条能力轴今天恰好同一批盘，但来源是不同字段**（不是复制粘贴）", () => {
    // 磁力看 resourceProviderKinds（搜索侧：哪些资源提供商适用于这个盘），
    // 字幕看 supportsSubtitleDirectLink（落盘侧：executor 会不会外链离线）。
    // 今天两批盘重合，是因为「有秒传/离线接口」这件事同时决定了两者——115/光鸭/123 有，
    // 夸克/天翼两个都没有。但它们是**不同的字段**：将来一家盘完全可能有磁力却没有离线
    // 下载额度（或反过来），那时两张名单必须各自正确，而这条断言保证它们不是同一个值。
    const magnet = brandsSupportingProwlarr().slice().sort();
    const subtitle = brandsSupportingSubtitleDirectLink().slice().sort();
    expect(subtitle).toEqual(magnet);
    // 各自是从自己的字段推的，不是把对方的结果抄过来
    for (const brand of STORAGE_BRANDS) {
      // brandSupportsProwlarr 读 resourceProviderKinds，brandSupportsSubtitleDirectLink
      // 读 supportsSubtitleDirectLink —— 两个不同字段，只是今天取值重合。
      const viaKinds = brandSupportsProwlarr(brand.provider);
      const viaDeclaration = brandSupportsSubtitleDirectLink(brand.provider);
      expect(viaDeclaration, `${brand.provider}`).toBe(viaKinds);
    }
  });
});
