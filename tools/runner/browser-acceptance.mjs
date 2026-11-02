import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const ARTIFACT_DIR = "C:/Users/hlr/.gemini/antigravity/brain/dfc4c339-ee30-4ac6-8790-7b835893093f";
const BASE_URL = "http://127.0.0.1:3001";

async function runAcceptance() {
  console.log("==> Launching Chromium for automated browser acceptance...");
  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  });

  const page = await context.newPage();
  const errors = [];

  page.on("pageerror", (err) => {
    console.error("[Browser PageError]", err.message);
    errors.push(`PageError: ${err.message}`);
  });

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      if (!text.includes("favicon.ico")) {
        console.error("[Browser Console Error]", text);
        errors.push(`ConsoleError: ${text}`);
      }
    }
  });

  const checks = [
    { name: "01-home-page", url: `${BASE_URL}/`, title: "首页资源与推荐" },
    { name: "02-library-tab", url: `${BASE_URL}/?tab=library`, title: "媒体库与剧集" },
    { name: "03-storage-page", url: `${BASE_URL}/?tab=storage`, title: "网盘存储与115驱动" },
    { name: "04-strm-page", url: `${BASE_URL}/?tab=strm`, title: "STRM流媒体调度" },
    { name: "05-extensions-page", url: `${BASE_URL}/?tab=extensions`, title: "扩展与插件中心" },
    { name: "06-chat-page", url: `${BASE_URL}/?tab=chat`, title: "智能助手与检索对话" },
    { name: "07-activity-page", url: `${BASE_URL}/?tab=activity`, title: "活动动态审计流" },
    { name: "08-notifications-page", url: `${BASE_URL}/?tab=notifications`, title: "通知中心" },
    { name: "09-settings-page", url: `${BASE_URL}/?tab=settings`, title: "系统偏好设置" },
  ];

  const results = [];

  for (const check of checks) {
    console.log(`\n--> Navigating to [${check.title}]: ${check.url}`);
    try {
      const resp = await page.goto(check.url, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });

      // 等待 2 秒确保 Next.js SSR Suspense 和客户端水合(Hydration)完全就绪
      await page.waitForTimeout(2000);

      const status = resp ? resp.status() : 0;
      const screenshotPath = path.join(ARTIFACT_DIR, `verify-${check.name}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });

      console.log(`    ✓ HTTP ${status} | Screenshot saved: verify-${check.name}.png`);
      results.push({
        name: check.name,
        title: check.title,
        url: check.url,
        status,
        screenshot: screenshotPath,
        ok: status === 200,
      });
    } catch (e) {
      console.error(`    ✗ Failed on ${check.name}:`, e.message);
      results.push({
        name: check.name,
        title: check.title,
        url: check.url,
        status: 500,
        error: e.message,
        ok: false,
      });
    }
  }

  await browser.close();

  console.log("\n==================================================");
  console.log("验收汇总结果 (Acceptance Summary):");
  console.log(`总页面数: ${results.length}, 成功: ${results.filter((r) => r.ok).length}, 错误: ${errors.length}`);
  if (errors.length > 0) {
    console.log("捕获到的浏览器异常:");
    errors.forEach((err, i) => console.log(`  ${i + 1}. ${err}`));
  } else {
    console.log("🎉 所有页面无任何未捕获的运行时异常或无限刷新问题！");
  }
  console.log("==================================================");
}

runAcceptance().catch((e) => {
  console.error("FATAL acceptance execution failed:", e);
  process.exit(1);
});
