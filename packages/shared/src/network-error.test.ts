import { describe, expect, it } from "vitest";
import { formatNetworkError } from "./network-error.js";

describe("formatNetworkError", () => {
  it("formats standard error without cause", () => {
    expect(formatNetworkError(new Error("simple error"))).toBe("simple error");
  });

  it("formats error with cause having code and message", () => {
    const error = new Error("fetch failed");
    (error as unknown as { cause: unknown }).cause = {
      code: "ECONNREFUSED",
      message: "connect ECONNREFUSED 127.0.0.1:2080",
    };
    expect(formatNetworkError(error)).toBe("fetch failed [ECONNREFUSED] ([object Object])");

    const errorWithCauseError = new Error("fetch failed");
    const causeError = new Error("connect ECONNREFUSED 127.0.0.1:2080");
    (causeError as unknown as { code: string }).code = "ECONNREFUSED";
    (errorWithCauseError as unknown as { cause: unknown }).cause = causeError;
    expect(formatNetworkError(errorWithCauseError)).toBe(
      "fetch failed [ECONNREFUSED] (connect ECONNREFUSED 127.0.0.1:2080)",
    );
  });

  it("formats string or primitive error", () => {
    expect(formatNetworkError("raw error string")).toBe("raw error string");
    expect(formatNetworkError(404)).toBe("404");
  });
});
