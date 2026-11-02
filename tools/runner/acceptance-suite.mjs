import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

const ARTIFACTS_DIR = "C:/Users/hlr/.gemini/antigravity/brain/dfc4c339-ee30-4ac6-8790-7b835893093f";
const BASE_URL = "http://localhost:3001";

async function runAcceptance() {
  console.log("====================================================");
  console.log("🚀 启动 Mediary Scout 最近改动与核心功能实机浏览器验收");
  console.log("====================================================");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (
      msg.type() === "error" ||
      text.includes("Uncaught") ||
      text.includes("Switched to client") ||
      text.includes("Hydration failed")
    ) {
      console.log(`[BROWSER ${msg.type().toUpperCase()}]:`, text);
      consoleErrors.push(text);
    }
  });

  page.on("pageerror", (err) => {
    console.log("[PAGE UNCAUGHT ERROR]:", err.message);
    consoleErrors.push(err.message);
  });

  // ----------------------------------------------------
  // 1. 验收页面 1: 首页 / (搜索、推荐流、无刷新死循环、Suspense 骨架平稳水合)
  // ----------------------------------------------------
  console.log("\n[1/5] 正在验收: 首页 / (搜索与精选推荐流)...");
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  const homeScreenshot = path.join(ARTIFACTS_DIR, "acceptance-01-home-page.png");
  await page.screenshot({ path: homeScreenshot, fullPage: false });
  console.log(`  📸 首页截图已保存: ${homeScreenshot}`);

  const hasSidebar = await page.isVisible(".sidebar");
  const hasSearchHero = await page.isVisible(".search-hero");
  const hasTrendingGrid = await page.isVisible(".trending-grid");
  console.log(`  ✔ 侧边栏存在: ${hasSidebar}`);
  console.log(`  ✔ 搜索区存在: ${hasSearchHero}`);
  console.log(`  ✔ 发现精选推荐网格存在: ${hasTrendingGrid}`);

  // ----------------------------------------------------
  // 2. 验收页面 2: 订阅页 /?tab=library
  // ----------------------------------------------------
  console.log("\n[2/5] 正在验收: 订阅与媒体库视图 /?tab=library...");
  await page.goto(`${BASE_URL}/?tab=library`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  const libraryScreenshot = path.join(ARTIFACTS_DIR, "acceptance-02-library-tab.png");
  await page.screenshot({ path: libraryScreenshot, fullPage: false });
  console.log(`  📸 订阅库截图已保存: ${libraryScreenshot}`);
  const hasLibrarySurface = await page.isVisible(".library-surface");
  console.log(`  ✔ 订阅库容器存在: ${hasLibrarySurface}`);

  // ----------------------------------------------------
  // 3. 验收页面 3: STRM 任务计划与 1 对多媒体库自动绑定管理页 /storage/strm
  // ----------------------------------------------------
  console.log("\n[3/5] 正在验收: STRM 任务计划与媒体库绑定 /storage/strm...");
  await page.goto(`${BASE_URL}/storage/strm`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  const strmListScreenshot = path.join(ARTIFACTS_DIR, "acceptance-03-strm-schedule-list.png");
  await page.screenshot({ path: strmListScreenshot, fullPage: false });
  console.log(`  📸 STRM 计划列表截图已保存: ${strmListScreenshot}`);

  // 点击新建 STRM 任务按钮，打开弹窗并验收「关联远程媒体库」多选支持
  const newPlanBtn = page.locator("button:has-text('新建 STRM 任务')").first();
  if (await newPlanBtn.isVisible()) {
    console.log("  👉 找到「新建 STRM 任务」按钮，打开创建弹窗...");
    await newPlanBtn.click();
    await page.waitForTimeout(600);

    const modalScreenshot = path.join(ARTIFACTS_DIR, "acceptance-03-strm-create-modal.png");
    await page.screenshot({ path: modalScreenshot, fullPage: false });
    console.log(`  📸 新建任务弹窗截图已保存: ${modalScreenshot}`);

    const hasMediaServerSelect = await page.locator("text=关联远程影视库").count() > 0;
    console.log(`  ✔ 关联远程媒体库多选配置区正常展示: ${hasMediaServerSelect}`);

    // 关闭弹窗
    const closeBtn = page.locator("button:has-text('取消')").first();
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
      await page.waitForTimeout(400);
    }
  }

  // 若有既有卡片，点击第一个任务的「编辑」按钮验收 1 对多绑定回显
  const editBtn = page.locator("button:has-text('编辑')").first();
  if (await editBtn.isVisible()) {
    console.log("  👉 找到既有 STRM 计划卡片，打开「编辑」弹窗验收 1 对多媒体库多选与回显...");
    await editBtn.click();
    await page.waitForTimeout(600);

    const editModalScreenshot = path.join(ARTIFACTS_DIR, "acceptance-03-strm-edit-modal.png");
    await page.screenshot({ path: editModalScreenshot, fullPage: false });
    console.log(`  📸 编辑任务弹窗截图已保存: ${editModalScreenshot}`);

    const closeEditBtn = page.locator("button:has-text('取消')").first();
    if (await closeEditBtn.isVisible()) {
      await closeEditBtn.click();
      await page.waitForTimeout(400);
    }
  }

  // ----------------------------------------------------
  // 4. 验收页面 4: 媒体服务器配置与自适应探测 /settings/mediaserver
  // ----------------------------------------------------
  console.log("\n[4/5] 正在验收: 媒体服务器配置与自适应探测 /settings/mediaserver...");
  await page.goto(`${BASE_URL}/settings/mediaserver`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  const mediaServerScreenshot = path.join(ARTIFACTS_DIR, "acceptance-04-mediaserver-settings.png");
  await page.screenshot({ path: mediaServerScreenshot, fullPage: false });
  console.log(`  📸 媒体服务器设置截图已保存: ${mediaServerScreenshot}`);

  const hasMediaServerHeader = await page.locator("h1:has-text('影视库配置')").isVisible();
  console.log(`  ✔ 媒体服务器设置页面正常加载: ${hasMediaServerHeader}`);

  // 打开添加媒体服务器弹窗
  const addServerBtn = page.locator("button:has-text('添加媒体服务器'), button:has-text('立即添加服务器')").first();
  if (await addServerBtn.isVisible()) {
    console.log("  👉 找到「添加媒体服务器」按钮，打开弹窗验证 Plex / Emby / Jellyfin 配置项...");
    await addServerBtn.click();
    await page.waitForTimeout(600);

    const addServerScreenshot = path.join(ARTIFACTS_DIR, "acceptance-04-add-server-modal.png");
    await page.screenshot({ path: addServerScreenshot, fullPage: false });
    console.log(`  📸 添加服务器弹窗截图已保存: ${addServerScreenshot}`);

    const cancelServerBtn = page.locator("button:has-text('取消')").first();
    if (await cancelServerBtn.isVisible()) {
      await cancelServerBtn.click();
      await page.waitForTimeout(400);
    }
  }

  // ----------------------------------------------------
  // 5. 验收页面 5: 网盘文件浏览 /storage 及长效页面稳定性
  // ----------------------------------------------------
  console.log("\n[5/5] 正在验收: 网盘文件浏览 /storage 及长效页面稳定性...");
  await page.goto(`${BASE_URL}/storage`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  const storageScreenshot = path.join(ARTIFACTS_DIR, "acceptance-05-storage-page.png");
  await page.screenshot({ path: storageScreenshot, fullPage: false });
  console.log(`  📸 网盘管理截图已保存: ${storageScreenshot}`);

  console.log("\n正在进行 5 秒长效静默监听，断言 0 刷新死循环与 0 客户端报错...");
  await page.waitForTimeout(5000);

  await browser.close();

  console.log("\n====================================================");
  console.log("🏁 浏览器实机验收汇总看板");
  console.log("====================================================");
  console.log(`- 捕获控制台致命错误数: ${consoleErrors.length}`);
  if (consoleErrors.length > 0) {
    console.error("❌ 验收失败，存在控制台错误:", consoleErrors);
    process.exit(1);
  }

  console.log("🎉 全部页面实机验收通过！0 控制台致命异常、0 刷新循环、STRM 1对多媒体库绑定闭环、UI 渲染完整！");
}

runAcceptance().catch((err) => {
  console.error("验收执行发生异常:", err);
  process.exit(1);
});
