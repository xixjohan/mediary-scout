import { chromium } from "playwright";
import path from "node:path";

const ARTIFACT_DIR = "C:/Users/hlr/.gemini/antigravity/brain/dfc4c339-ee30-4ac6-8790-7b835893093f";
const URL = "http://127.0.0.1:3001/?tab=storage";

async function verify115OAuthUI() {
  console.log("==> Launching Chromium to verify 115 Open OAuth UI...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  console.log(`Navigating to ${URL}...`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForTimeout(2000);

  // 点击展开 115 开放平台双轨增强面板
  const summaryEl = await page.locator("summary", { hasText: "115 开放平台 (Open OAuth) 双轨增强" }).first();
  if (await summaryEl.isVisible()) {
    console.log("Clicking to expand 115 Open OAuth panel...");
    await summaryEl.click();
    await page.waitForTimeout(1000);
  }

  const screenshotPath = path.join(ARTIFACT_DIR, "verify-115-open-oauth-expanded.png");
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`✓ Screenshot captured: ${screenshotPath}`);

  await browser.close();
}

verify115OAuthUI().catch((e) => {
  console.error("Failed:", e);
  process.exit(1);
});
