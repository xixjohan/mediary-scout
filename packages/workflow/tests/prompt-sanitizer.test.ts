import { describe, expect, it } from "vitest";
import {
  injectSafetyPreamble,
  isContentBlockedError,
  isGatewayServerError,
  sanitizePromptText,
} from "../src/acquisition-v2/prompt-sanitizer.js";

describe("sanitizePromptText", () => {
  it("过滤博彩、色情敏感噪词与多余空白", () => {
    const raw = "【澳门新葡京开奖】 流浪地球2 2160p 无码内嵌中字 www.gambling123.com";
    const cleaned = sanitizePromptText(raw);
    expect(cleaned).not.toContain("新葡京");
    expect(cleaned).not.toContain("无码");
    expect(cleaned).not.toContain("gambling123.com");
    expect(cleaned).toContain("流浪地球2 2160p 内嵌中字");
  });

  it("空串或纯净文本安全透传", () => {
    expect(sanitizePromptText("")).toBe("");
    expect(sanitizePromptText("奥本海默 2023 1080p")).toBe("奥本海默 2023 1080p");
  });
});

describe("injectSafetyPreamble", () => {
  it("向系统提示词前置注入安全合规声明", () => {
    const sys = "You are a media acquisition agent.";
    const injected = injectSafetyPreamble(sys);
    expect(injected).toContain("【系统合规与上下文说明】");
    expect(injected).toContain(sys);

    // 二次注入幂等
    expect(injectSafetyPreamble(injected)).toBe(injected);
  });
});

describe("isContentBlockedError", () => {
  it("识别上游 Gemini / Azure / Qwen 审查中断消息", () => {
    expect(
      isContentBlockedError(
        new Error("The content you provided or machine outputted is blocked."),
      ),
    ).toBe(true);
    expect(
      isContentBlockedError(new Error("Response stopped due to content-filter")),
    ).toBe(true);
    expect(isContentBlockedError(new Error("Network timeout"))).toBe(false);
  });

  it("支持递归解开 cause 链中的审查错误", () => {
    const root = new Error(
      "The content you provided or machine outputted is blocked.",
    );
    const wrapped = new Error("Step failed", { cause: root });
    expect(isContentBlockedError(wrapped)).toBe(true);
  });
});

describe("isGatewayServerError", () => {
  it("识别 503 与 502 网关错误", () => {
    expect(isGatewayServerError({ statusCode: 503 })).toBe(true);
    expect(isGatewayServerError(new Error("HTTP 503 Service Unavailable"))).toBe(
      true,
    );
    expect(isGatewayServerError(new Error("404 Not Found"))).toBe(false);
  });
});
