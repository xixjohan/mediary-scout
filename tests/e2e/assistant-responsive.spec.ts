import { expect, test, type Page } from "@playwright/test";

const conversation = {
  id: "conv-responsive",
  accountId: "acct_default",
  title: "窄屏会话历史",
  messageCount: 2,
  createdAt: "2026-11-06T10:00:00.000Z",
  updatedAt: "2026-11-06T10:00:00.000Z",
};

async function mockConversationList(page: Page) {
  await page.route(/\/api\/chat\/conversations\/?$/, (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([conversation]),
    });
  });
  await page.route(/\/api\/chat\/conversations\/conv-responsive\/?$/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ messages: [] }),
    }),
  );
}

test.describe("助手响应式工作台", () => {
  test("窄屏使用单栏历史抽屉，所有视口没有页面级横向溢出", async ({ page }) => {
    await mockConversationList(page);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const viewports = [
      [320, 640],
      [375, 812],
      [390, 844],
      [430, 932],
      [768, 1024],
      [860, 900],
      [861, 900],
      [1024, 768],
      [1199, 900],
      [1200, 900],
      [1365, 900],
    ] as const;

    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await page.goto("/chat");
      await expect(page.getByRole("heading", { name: "智能助理" })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
        .toBeLessThanOrEqual(1);

      const historyButton = page.getByRole("button", { name: "会话历史", exact: true });
      const historySidebar = page.getByRole("complementary", { name: "会话列表" });
      if (width < 1200) {
        await expect(historyButton).toBeVisible();
        await expect(historySidebar).not.toBeVisible();
      } else {
        await expect(historySidebar).toBeVisible();
        await expect(historyButton).not.toBeVisible();
      }

      const headerColumns = await page.evaluate(() => {
        const left = document.querySelector(".chat-header-left")?.getBoundingClientRect();
        const right = document.querySelector(".chat-header-actions")?.getBoundingClientRect();
        return left && right ? { leftRight: left.right, rightLeft: right.left } : null;
      });
      expect(headerColumns, `header elements exist at ${width}px`).not.toBeNull();
      expect(headerColumns!.leftRight, `header columns overlap at ${width}px`).toBeLessThanOrEqual(
        headerColumns!.rightLeft + 1,
      );
      await expect(page.getByRole("textbox", { name: /输入自然语言/ })).toBeVisible();
      await expect(page.getByRole("button", { name: "发送消息" })).toBeVisible();
      await expect(page.getByRole("button", { name: "打开 MCP 工具编排" })).toBeVisible();
      if (width <= 860) {
        const composerClearsNavigation = await page.evaluate(() => {
          const composer = document.querySelector(".chat-input-bar")?.getBoundingClientRect();
          const nav = document.querySelector(".sidebar > nav")?.getBoundingClientRect();
          return composer && nav ? composer.bottom <= nav.top + 1 : false;
        });
        expect(composerClearsNavigation, `composer is covered by bottom navigation at ${width}px`).toBe(true);
      }
    }

    expect(pageErrors).toEqual([]);
  });

  test("历史抽屉支持会话选择、Escape 关闭与焦点返回", async ({ page }) => {
    await mockConversationList(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/chat");

    const historyButton = page.getByRole("button", { name: "会话历史", exact: true });
    await historyButton.click();
    const dialog = page.getByRole("dialog", { name: "会话历史" });
    await expect(dialog).toBeVisible();
    const newChatButton = dialog.getByRole("button", { name: "新建对话" });
    await expect(newChatButton).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "删除会话" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(newChatButton).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(historyButton).toBeFocused();

    await historyButton.click();
    await dialog.getByRole("button", { name: "窄屏会话历史" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "窄屏会话历史" })).toBeVisible();

    await historyButton.click();
    await dialog.getByRole("button", { name: "新建对话" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "智能助理" })).toBeVisible();

    await historyButton.click();
    await expect(dialog).toBeVisible();
    await page.locator(".chat-sidebar-backdrop").click({ position: { x: 360, y: 400 } });
    await expect(dialog).not.toBeVisible();
    await expect(historyButton).toBeFocused();
  });

  test("会话列表加载失败时显示可重试错误", async ({ page }) => {
    let attempts = 0;
    await page.route(/\/api\/chat\/conversations\/?$/, async (route) => {
      attempts += 1;
      if (attempts === 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "暂时不可用" }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([conversation]),
      });
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/chat");
    await expect(page.getByText("正在加载会话…")).toBeVisible();
    await expect(page.getByRole("alert").getByText("会话列表加载失败")).toBeVisible();
    await page.getByRole("button", { name: "重试加载会话" }).click();
    await expect(page.getByRole("button", { name: "窄屏会话历史", exact: true })).toBeVisible();
    expect(attempts).toBe(2);
  });

  test("历史详情加载失败不会伪装成新会话，并提供重试", async ({ page }) => {
    let attempts = 0;
    await page.route(/\/api\/chat\/conversations\/?$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([conversation]),
      }),
    );
    await page.route(/\/api\/chat\/conversations\/conv-responsive\/?$/, (route) => {
      attempts += 1;
      return route.fulfill(
        attempts === 1
          ? { status: 503, contentType: "application/json", body: JSON.stringify({ error: "暂时不可用" }) }
          : {
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                messages: [
                  {
                    id: "msg-responsive",
                    conversationId: conversation.id,
                    accountId: conversation.accountId,
                    role: "assistant",
                    content: "恢复后的历史消息",
                    createdAt: conversation.updatedAt,
                  },
                ],
              }),
          },
      );
    });

    await page.goto("/chat?c=conv-responsive");
    await expect(page.getByRole("alert").getByText("会话记录加载失败")).toBeVisible();
    await expect(page.getByText("你好！我是巡影智能助理", { exact: false })).not.toBeVisible();
    await page.getByRole("button", { name: "重新加载会话记录" }).click();
    await expect(page.getByText("恢复后的历史消息")).toBeVisible();
    expect(attempts).toBe(2);
  });

  test("会话列表行使用独立按钮语义", async ({ page }) => {
    await mockConversationList(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/chat");

    const item = page.getByRole("listitem").filter({ hasText: "窄屏会话历史" });
    await expect(item).toBeVisible();
    await expect(item).not.toHaveAttribute("role", "button");
    await expect(item.getByRole("button", { name: "窄屏会话历史", exact: true })).toBeVisible();
    await item.hover();
    await expect(item.getByRole("button", { name: "重命名" })).toBeVisible();
    await expect(item.getByRole("button", { name: "删除会话" })).toBeVisible();
  });

  test("相似工作台页面在手机宽度没有页面级横向溢出", async ({ page }) => {
    const routes = [
      ["/", 375],
      ["/?tab=library", 375],
      ["/storage", 320],
      ["/storage", 375],
      ["/activity", 375],
      ["/settings", 375],
      ["/storage/strm", 375],
      ["/notifications", 375],
      ["/show/27205", 375],
    ] as const;

    for (const [route, width] of routes) {
      await page.setViewportSize({ width, height: 812 });
      await page.goto(route);
      await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      const overflowElements =
        overflow > 1
          ? await page.evaluate(() =>
              Array.from(document.body.querySelectorAll<HTMLElement>("*"))
                .map((element) => ({
                  tag: element.tagName.toLowerCase(),
                  className: typeof element.className === "string" ? element.className : "",
                  right: Math.round(element.getBoundingClientRect().right),
                  width: Math.round(element.getBoundingClientRect().width),
                  scrollWidth: element.scrollWidth,
                  clientWidth: element.clientWidth,
                  text: (element.innerText ?? "").slice(0, 60),
                  css: {
                    width: getComputedStyle(element).width,
                    minWidth: getComputedStyle(element).minWidth,
                    whiteSpace: getComputedStyle(element).whiteSpace,
                    flex: getComputedStyle(element).flex,
                  },
                  parents: [element.parentElement, element.parentElement?.parentElement]
                    .filter((parent): parent is HTMLElement => Boolean(parent))
                    .map((parent) => ({
                      tag: parent.tagName.toLowerCase(),
                      className: typeof parent.className === "string" ? parent.className : "",
                      left: Math.round(parent.getBoundingClientRect().left),
                      right: Math.round(parent.getBoundingClientRect().right),
                      width: Math.round(parent.getBoundingClientRect().width),
                    })),
                }))
                .filter((element) => element.right > document.documentElement.clientWidth + 1)
                .sort((left, right) => right.right - left.right)
                .slice(0, 8),
            )
          : [];
      expect(
        overflow,
        `${route} has ${overflow}px overflow at ${width}px: ${JSON.stringify(overflowElements)}`,
      ).toBeLessThanOrEqual(1);
    }
  });

  test("合成长会话记录渲染基线与发送请求体大小", async ({ page }) => {
    const sizes = [50, 200, 500];
    const reports: Array<{
      messages: number;
      loadMs: { p50: number; p95: number };
      scrollFrameMs: { p50: number; p95: number };
      rowCount: number;
      scrollHeight: number;
      postBytes?: number;
    }> = [];

    await page.setViewportSize({ width: 375, height: 812 });
    await page.route(/\/api\/chat\/conversations\/?$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([conversation]),
      }),
    );

    for (const size of sizes) {
      const messages = Array.from({ length: size }, (_, index) => ({
        id: `perf-${size}-${index}`,
        conversationId: conversation.id,
        accountId: conversation.accountId,
        role: index % 2 === 0 ? "assistant" : "user",
        content: `历史消息 ${index + 1}：用于验证助手长会话的渲染和滚动基线。`,
        createdAt: new Date(Date.UTC(2026, 10, 6, 10, 0, index)).toISOString(),
      }));
      await page.route(/\/api\/chat\/conversations\/conv-responsive\/?$/, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ messages }),
        }),
      );

      const loadSamples: number[] = [];
      for (let sample = 0; sample < 5; sample += 1) {
        const startedAt = performance.now();
        await page.goto(`/chat?c=conv-responsive&perf=${sample}`);
        await expect(page.locator(".chat-message-list .chat-message-row")).toHaveCount(size);
        loadSamples.push(performance.now() - startedAt);
      }

      const scroll = await page.evaluate(async () => {
        const list = document.querySelector<HTMLElement>(".chat-message-list");
        if (!list) throw new Error("chat message list is missing");
        list.style.scrollBehavior = "auto";
        const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight);
        const frames: number[] = [];
        let previous = performance.now();
        for (let step = 1; step <= 30; step += 1) {
          list.scrollTop = Math.round((maxScroll * step) / 30);
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => {
              const now = performance.now();
              frames.push(now - previous);
              previous = now;
              resolve();
            }),
          );
        }
        return { rowCount: list.querySelectorAll(".chat-message-row").length, scrollHeight: list.scrollHeight, frames };
      });

      const sortedLoads = [...loadSamples].sort((left, right) => left - right);
      const sortedFrames = [...scroll.frames].sort((left, right) => left - right);
      const report: (typeof reports)[number] = {
        messages: size,
        loadMs: { p50: Math.round(sortedLoads[2] ?? 0), p95: Math.round(sortedLoads[4] ?? 0) },
        scrollFrameMs: {
          p50: Math.round(sortedFrames[14] ?? 0),
          p95: Math.round(sortedFrames[28] ?? 0),
        },
        rowCount: scroll.rowCount,
        scrollHeight: scroll.scrollHeight,
      };

      if (size === 500) {
        let postBytes = 0;
        await page.route("**/api/chat", (route) => {
          postBytes = route.request().postDataBuffer()?.byteLength ?? 0;
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              reply: "基线响应",
              suggestedPrompts: [],
              conversationId: conversation.id,
            }),
          });
        });
        await page.getByRole("textbox", { name: /输入自然语言/ }).fill("检查上下文传输");
        await page.getByRole("button", { name: "发送消息" }).click();
        await expect(page.getByText("基线响应")).toBeVisible();
        report.postBytes = postBytes;
      }

      reports.push(report);
    }

    console.info("[assistant-perf-baseline]", JSON.stringify(reports));
  });
});
