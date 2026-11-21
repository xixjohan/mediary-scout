import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyText, copyTextWithResult } from "./copy-text";

describe("copy-text", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalNavigator = globalThis.navigator;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.navigator = originalNavigator;
  });

  it("在安全上下文且支持 Clipboard API 时使用 clipboard 策略", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    const result = await copyTextWithResult("test-secret-123");
    expect(result).toEqual({ success: true, strategy: "clipboard" });
    expect(writeTextMock).toHaveBeenCalledWith("test-secret-123");

    const boolResult = await copyText("test-secret-123");
    expect(boolResult).toBe(true);
  });

  it("在 HTTP 局域网非安全上下文 (isSecureContext=false) 时自动降级为 execCommand", async () => {
    const execCommandMock = vi.fn().mockReturnValue(true);
    const appendChildMock = vi.fn();
    const removeChildMock = vi.fn();

    vi.stubGlobal("window", { isSecureContext: false });
    vi.stubGlobal("navigator", {}); // 无 clipboard
    vi.stubGlobal("document", {
      execCommand: execCommandMock,
      activeElement: null,
      createElement: vi.fn().mockReturnValue({
        setAttribute: vi.fn(),
        style: {},
        focus: vi.fn(),
        select: vi.fn(),
        setSelectionRange: vi.fn(),
        remove: removeChildMock,
      }),
      body: {
        appendChild: appendChildMock,
      },
    });

    const result = await copyTextWithResult("msk_live_test_api_key");
    expect(result).toEqual({ success: true, strategy: "execCommand" });
    expect(execCommandMock).toHaveBeenCalledWith("copy");

    const boolResult = await copyText("msk_live_test_api_key");
    expect(boolResult).toBe(true);
  });

  it("当 Clipboard API 写入拒绝时，平滑降级到 execCommand", async () => {
    const writeTextMock = vi.fn().mockRejectedValue(new Error("Permission denied"));
    const execCommandMock = vi.fn().mockReturnValue(true);

    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: writeTextMock,
      },
    });
    vi.stubGlobal("document", {
      execCommand: execCommandMock,
      activeElement: null,
      createElement: vi.fn().mockReturnValue({
        setAttribute: vi.fn(),
        style: {},
        focus: vi.fn(),
        select: vi.fn(),
        setSelectionRange: vi.fn(),
        remove: vi.fn(),
      }),
      body: {
        appendChild: vi.fn(),
      },
    });

    const result = await copyTextWithResult("fallback-test");
    expect(result).toEqual({ success: true, strategy: "execCommand" });
    expect(writeTextMock).toHaveBeenCalled();
    expect(execCommandMock).toHaveBeenCalledWith("copy");
  });

  it("当两层策略均不可用时返回 manual 失败结果，不抛出异常", async () => {
    vi.stubGlobal("window", { isSecureContext: false });
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", {
      execCommand: vi.fn().mockReturnValue(false),
      activeElement: null,
      createElement: vi.fn().mockReturnValue({
        setAttribute: vi.fn(),
        style: {},
        focus: vi.fn(),
        select: vi.fn(),
        setSelectionRange: vi.fn(),
        remove: vi.fn(),
      }),
      body: {
        appendChild: vi.fn(),
      },
    });

    const result = await copyTextWithResult("fail-test");
    expect(result).toEqual({ success: false, strategy: "manual" });

    const boolResult = await copyText("fail-test");
    expect(boolResult).toBe(false);
  });
});
