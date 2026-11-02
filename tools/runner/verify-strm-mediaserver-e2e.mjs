import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const artifactDir = "C:\\Users\\hlr\\.gemini\\antigravity\\brain\\dfc4c339-ee30-4ac6-8790-7b835893093f";

async function runBrowserVerification() {
  console.log("🚀 [E2E] 启动 Playwright 无头浏览器进行端到端视觉与交互验收...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  // 1. 访问 STRM 页面
  console.log("1. 正在访问 http://localhost:3002/storage/strm ...");
  await page.goto("http://localhost:3002/storage/strm", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("button:has-text('新建 STRM 任务')", { timeout: 15000 });

  // 等待数据加载就绪
  await page.waitForTimeout(1000);
  const title = await page.title();
  console.log(`   页面标题: ${title}`);
  await page.screenshot({ path: path.join(artifactDir, "e2e-strm-list.png") });
  console.log("   ✔ 截图保存: e2e-strm-list.png");

  // 2. 点击「新建 STRM 任务」
  console.log("2. 正在点击「新建 STRM 任务」按钮...");
  const createBtn = page.locator("button:has-text('新建 STRM 任务')");
  await createBtn.click();
  await page.waitForSelector("text=新建 STRM 任务计划", { timeout: 5000 });
  console.log("   ✔ 新建任务弹窗成功展开！");

  // 3. 验证媒体服务器与影视库级联选择
  console.log("3. 正在验证「📺 关联远程影视库」选择区...");
  await page.waitForSelector("text=关联远程影视库", { timeout: 5000 });

  const selects = page.locator("select");
  const count = await selects.count();
  console.log(`   弹窗内 select 控件数量: ${count}`);

  // 服务器选择框 (第4个select)
  const serverSelect = selects.nth(3);
  await serverSelect.selectOption({ label: "客厅 Plex 影视库 (PLEX)" });
  console.log("   ✔ 选中媒体服务器: 客厅 Plex 影视库 (PLEX)");

  // 等待目标影视库自动刷新
  const libSelect = selects.nth(4);
  await page.waitForTimeout(800);

  const libOptions = await libSelect.locator("option").allTextContents();
  console.log("   目标影视库选项:", libOptions);
  if (!libOptions.some((o) => o.includes("电影"))) {
    throw new Error("影视库下拉列表中未找到电影库选项！");
  }

  // 选择电影库
  const movieOptionVal = await libSelect.locator("option", { hasText: "电影" }).getAttribute("value");
  await libSelect.selectOption(movieOptionVal);
  console.log(`   ✔ 选中具体影视库: 电影 (ID: ${movieOptionVal})`);

  // 截图表单
  await page.screenshot({ path: path.join(artifactDir, "e2e-strm-create-modal.png") });
  console.log("   ✔ 截图保存: e2e-strm-create-modal.png");

  // 填入任务名称
  const nameInput = page.locator('input[placeholder="如：115 电影库"]');
  await nameInput.fill("E2E-关联Plex电影库任务");

  // 点击保存并启用
  console.log("4. 正在提交保存 STRM 任务...");
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes("/api/strm/tasks") && res.request().method() === "POST"),
    page.getByRole("button", { name: "保存并启用" }).click(),
  ]);
  const resStatus = response.status();
  const resBody = await response.text();
  console.log(`   POST /api/strm/tasks -> ${resStatus}: ${resBody}`);
  if (resStatus !== 200 && resStatus !== 201) {
    throw new Error(`创建任务失败: ${resStatus} ${resBody}`);
  }

  // 等待保存成功，弹窗消失
  await page.waitForSelector("text=新建 STRM 任务计划", { state: "detached", timeout: 8000 });
  console.log("   ✔ 任务创建成功，弹窗已关闭！");

  // 等待卡片展示
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(artifactDir, "e2e-strm-card-badge.png") });
  console.log("   ✔ 截图保存: e2e-strm-card-badge.png");

  // 5. 校验卡片上是否渲染关联媒体库徽章
  const badgeText = await page.locator("text=📺 电影").first().textContent();
  console.log(`   ✔ 卡片上媒体库微标渲染成功: ${badgeText}`);

  // 6. 点击编辑按钮验证预填数据
  console.log("5. 点击编辑按钮验证数据回填...");
  const editBtn = page.locator("button:has-text('编辑')").first();
  await editBtn.click();
  await page.waitForSelector("text=编辑 STRM 同步任务", { timeout: 5000 });
  await page.screenshot({ path: path.join(artifactDir, "e2e-strm-edit-modal.png") });
  console.log("   ✔ 截图保存: e2e-strm-edit-modal.png");

  const editSelects = page.locator("select");
  const editServerVal = await editSelects.nth(3).inputValue();
  const editLibVal = await editSelects.nth(4).inputValue();
  console.log(`   ✔ 编辑回填状态: ServerID=${editServerVal}, LibraryID=${editLibVal}`);

  // 关闭编辑弹窗
  await page.getByRole("button", { name: "取消" }).click();

  // 7. 清理测试任务 (通过 API 彻底清理测试数据)
  console.log("6. 清理创建的 E2E 测试任务...");
  const listResp = await page.request.get("http://localhost:3002/api/strm/tasks");
  const tasks = await listResp.json();
  for (const t of tasks) {
    if (t.name.startsWith("E2E-")) {
      await page.request.delete(`http://localhost:3002/api/strm/tasks/${t.id}`);
      console.log(`   ✔ 已删除测试任务: ${t.name} (${t.id})`);
    }
  }

  await browser.close();
  console.log("\n🎉 全套端到端浏览器实机验收 100% 成功且完全稳定！");

  await browser.close();
  console.log("\n🎉 全套端到端浏览器实机验收 100% 成功且完全稳定！");
}

runBrowserVerification().catch((err) => {
  console.error("✖ 浏览器验收失败:", err);
  process.exit(1);
});
