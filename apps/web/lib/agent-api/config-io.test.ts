import { describe, expect, it } from "vitest";
import { maskSecret, isMaskedPlaceholder } from "./config-io";

describe("maskSecret", () => {
  it("masks a long secret keeping the last 4 chars", () => {
    expect(maskSecret("sk-abcdefghijklmnop")).toBe("***mnop");
  });

  it("fully masks a short secret", () => {
    expect(maskSecret("abc123")).toBe("***");
  });

  it("returns null for empty / whitespace / nullish", () => {
    expect(maskSecret(null)).toBeNull();
    expect(maskSecret(undefined)).toBeNull();
    expect(maskSecret("")).toBeNull();
    expect(maskSecret("   ")).toBeNull();
  });
});

describe("isMaskedPlaceholder", () => {
  it("detects a masked value being echoed back", () => {
    expect(isMaskedPlaceholder("***mnop")).toBe(true);
    expect(isMaskedPlaceholder("sk-***7f2a")).toBe(true);
    expect(isMaskedPlaceholder("***")).toBe(true);
  });

  it("passes a genuine new secret", () => {
    expect(isMaskedPlaceholder("sk-realkey123456")).toBe(false);
    expect(isMaskedPlaceholder("https://api.example.com")).toBe(false);
  });
});
