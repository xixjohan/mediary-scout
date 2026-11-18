import { expect, test, type Page } from "@playwright/test";

/**
 * 关键字投放页的窄屏可用性（同类问题不复发）。
 *
 * 缺陷原型（2026-11-18 Dev 3020 实测，视口 710px）：
 *  `document.documentElement.scrollWidth = 895`，页面级横向溢出 185px。
 *  根因是三层 `min-width: auto` 叠加：`.owner-ingest-candidate-title` 是
 *  `nowrap + ellipsis`，它的 max-content（单条标题 700+ 字符）经过
 *  `.owner-ingest-candidates` → `.panel`（grid 隐式轨道）一路把视口撑宽；
 *  `.resource-filter-chips-row` 同样是不换行的长条（min-content 130px）。
 *
 * 断言两件事，都只看真实计算布局：
 *  1. 页面级无横向滚动（scrollWidth - clientWidth ≤ 1，允许浏览器舍入）；
 *  2. 筛选分面行在窄屏下真的换行（`resource-filter-chips-row` 出现多行），
 *     而不是靠 `overflow-x: hidden` 把溢出藏起来。
 */
const VIEWPORTS = [
  [320, 640],
  [360, 740],
  [375, 812],
  [390, 844],
  [430, 932],
  [768, 1024],
  [1024, 768],
] as const;

async function openOwnerIngest(page: Page) {
  await page.goto("/storage/owner-ingest");
  // 页面守卫是 owner-only；非站长会落到拒绝页，这里断言投放面板本身可见。
  await expect(page.getByRole("heading", { name: "关键字投放" })).toBeVisible();
}

test.describe("关键字投放窄屏布局", () => {
  test("各视口均无页面级横向滚动", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    for (const [width, height] of VIEWPORTS) {
      await page.setViewportSize({ width, height });
      await openOwnerIngest(page);
      await expect
        .poll(
          () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
          { message: `视口 ${width}x${height} 出现页面级横向溢出` },
        )
        .toBeLessThanOrEqual(1);
    }

    expect(pageErrors).toEqual([]);
  });

  test("Frieren 筛选分面在窄屏换行且不撑破容器（有真实候选渲染时）", async ({ page }) => {
    // 该用例只在 demo/fake 栈里有确定性候选；真实部署无候选时跳过宽度断言，
    // 但仍校验无溢出（面板头部与检索行本身也会撑宽）。
    await page.setViewportSize({ width: 320, height: 640 });
    await openOwnerIngest(page);

    const filterBar = page.locator(".resource-filter-chips-row").first();
    if ((await filterBar.count()) === 0) {
      test.info().annotations.push({ type: "skip-reason", description: "该环境未返回候选，分面行不存在（已单独覆盖无溢出断言）" });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
        .toBeLessThanOrEqual(1);
      return;
    }

    const layout = await filterBar.evaluate((row) => {
      const chips = Array.from(row.querySelectorAll(".resource-filter-chip"));
      const distinctTops = new Set(chips.map((chip) => Math.round(chip.getBoundingClientRect().top)));
      const rowRect = row.getBoundingClientRect();
      return {
        chipCount: chips.length,
        distinctTops: distinctTops.size,
        rowRight: Math.round(rowRect.right),
        chipMaxRight: Math.max(...chips.map((chip) => Math.round(chip.getBoundingClientRect().right))),
      };
    });

    // 有多个 chip 时必须真的换行（≥2 个不同的 top）。
    if (layout.chipCount > 3) {
      expect(layout.distinctTops).toBeGreaterThan(1);
    }
    // 任何 chip 都不得越出分面行右边界（越界 = 溢出被藏起来而不是换行）。
    expect(layout.chipMaxRight).toBeLessThanOrEqual(layout.rowRight + 1);
  });
});
