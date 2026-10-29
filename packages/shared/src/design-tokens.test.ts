import { describe, expect, it } from "vitest";
import {
  DESIGN_TOKENS,
  camelToKebab,
  tokenVar,
} from "./design-tokens.js";

describe("Design Tokens System", () => {
  it("defines standard dark mode brand and surface tokens", () => {
    expect(DESIGN_TOKENS.colors.bgBase).toBe("#121212");
    expect(DESIGN_TOKENS.colors.accent).toBe("#1ed760");
    expect(DESIGN_TOKENS.colors.danger).toBe("#f3727f");
    expect(DESIGN_TOKENS.colors.warning).toBe("#ffa42b");
    expect(DESIGN_TOKENS.colors.info).toBe("#539df5");
  });

  it("defines media and file type tokens for all 7 standard categories", () => {
    const { colors } = DESIGN_TOKENS;
    expect(colors.fileFolder).toBeDefined();
    expect(colors.fileFolderBg).toContain("rgba");
    expect(colors.fileVideo).toBeDefined();
    expect(colors.fileVideoBg).toContain("rgba");
    expect(colors.fileSubtitle).toBeDefined();
    expect(colors.fileSubtitleBg).toContain("rgba");
    expect(colors.fileAudio).toBeDefined();
    expect(colors.fileAudioBg).toContain("rgba");
    expect(colors.fileArchive).toBeDefined();
    expect(colors.fileArchiveBg).toContain("rgba");
    expect(colors.fileImage).toBeDefined();
    expect(colors.fileImageBg).toContain("rgba");
    expect(colors.fileGeneric).toBeDefined();
    expect(colors.fileGenericBg).toContain("rgba");
  });

  it("defines radii and shadow scales", () => {
    expect(DESIGN_TOKENS.radii.pill).toBe("9999px");
    expect(DESIGN_TOKENS.radii.sm).toBe("4px");
    expect(DESIGN_TOKENS.radii.lg).toBe("8px");
    expect(DESIGN_TOKENS.shadows.glowAccent).toContain("rgba(30, 215, 96");
    expect(DESIGN_TOKENS.transitions.base).toBeDefined();
  });

  it("formats CSS variable references correctly with tokenVar", () => {
    expect(tokenVar("accent")).toBe("var(--accent)");
    expect(tokenVar("--bg-base")).toBe("var(--bg-base)");
    expect(tokenVar("file-video")).toBe("var(--file-video)");
  });

  it("converts camelCase property names to kebab-case with camelToKebab", () => {
    expect(camelToKebab("bgBase")).toBe("bg-base");
    expect(camelToKebab("accentSubtleBorder")).toBe("accent-subtle-border");
    expect(camelToKebab("fileFolderBg")).toBe("file-folder-bg");
  });
});
