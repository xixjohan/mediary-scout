import { expect, test } from "@playwright/test";

/**
 * 搜索 → 获取 → 队列 → 终态 → UI 反映（fake 全栈，S4.3）。
 * 断言语义谨慎：stub agent 必定报无源，所以断言「回路完整走通 + UI 如实
 * 反映终态」，不断言「获取成功」——后者需要真实网盘（live 套件）。
 */
test.describe("获取回路（fake 全栈）", () => {
  test("首页渲染：搜索框与导航就位", async ({ page }) => {
    await page.goto("/");
    // 输入框是 type="text"（无 type 属性）→ ARIA role 是 textbox，不是 searchbox。
    await expect(page.getByRole("textbox", { name: "搜索媒体" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  });

  test("搜索 demo 片源：结果卡渲染", async ({ page }) => {
    await page.goto("/?q=" + encodeURIComponent("翘楚"));
    // 结果区出现该片名（demo provider 确定性候选）
    await expect(page.getByText("翘楚").first()).toBeVisible();
  });

  test("健康探针：/api/health 走真实查询路径返回 200", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
  });

  test("点获取：入队 → worker 认领 → 队列被 drain 干净（无卡滞）", async ({ page }) => {
    await page.goto("/?q=" + encodeURIComponent("翘楚"));
    const acquire = page.getByRole("button", { name: /获取/ }).first();
    await expect(acquire).toBeVisible();
    await acquire.click();

    // 回路闭环的服务端可观测证据：in-process worker 认领并跑完后，
    // 「获取中」与「排队中」都必须为空——若 worker 坏/没起，run 会永远
    // 卡在排队里。（stub agent 必定报 no_coverage，终态落在 DB 里；
    // 「已完成」按客户端会话过滤、历史在通知页，故不断言那一层。）
    await page.goto("/activity");
    await expect(page.getByText("当前没有正在处理的任务。")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("没有排队的任务。")).toBeVisible();
  });
});
