import { describe, expect, it } from "vitest";
import { chooseCopyStrategy } from "./clipboard";

describe("chooseCopyStrategy", () => {
  it("安全上下文优先用 Clipboard API", () => {
    expect(chooseCopyStrategy({ hasClipboard: true, hasExecCommand: true })).toBe("clipboard");
    expect(chooseCopyStrategy({ hasClipboard: true, hasExecCommand: false })).toBe("clipboard");
  });

  it("HTTP 局域网源（无 Clipboard API）降级到 execCommand", () => {
    expect(chooseCopyStrategy({ hasClipboard: false, hasExecCommand: true })).toBe("execCommand");
  });

  it("两者都不可用时交给 UI 手动复制", () => {
    expect(chooseCopyStrategy({ hasClipboard: false, hasExecCommand: false })).toBe("manual");
  });
});
