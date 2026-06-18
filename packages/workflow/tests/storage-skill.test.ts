import { describe, expect, it } from "vitest";
import { getStorageSkill, readSkillSection } from "../src/index.js";

describe("brand-aware storage skill", () => {
  it("getStorageSkill('quark') teaches 转存分享, 无磁力, and fail-loud codes", () => {
    const quark = getStorageSkill("quark");
    expect(quark).toContain("转存分享");
    expect(quark).toMatch(/无磁力|NO magnet|没有.*磁力/i);
    expect(quark).toContain("41006"); // 分享不存在 fail-loud code
    expect(quark).toContain("夸克");
  });

  it("getStorageSkill('pan115') keeps the 115 transfer model (秒传/magnet)", () => {
    const pan115 = getStorageSkill("pan115");
    expect(pan115).toContain("115");
    expect(pan115).toMatch(/秒传/);
    expect(pan115).toMatch(/magnet/i);
    expect(pan115).not.toContain("41006"); // 115 has no quark codes
  });

  it("getStorageSkill throws for an unknown brand", () => {
    expect(() => getStorageSkill("baidu")).toThrowError(/unknown storage brand/i);
  });

  it("readSkillSection selects the brand variant for dead-links-black-box", () => {
    expect(readSkillSection("dead-links-black-box", "quark")).toBe(getStorageSkill("quark"));
    expect(readSkillSection("dead-links-black-box", "pan115")).toBe(getStorageSkill("pan115"));
    // defaults to 115 when no brand is given (single-user / legacy)
    expect(readSkillSection("dead-links-black-box")).toBe(getStorageSkill("pan115"));
  });

  it("readSkillSection still serves shared sections regardless of brand", () => {
    expect(readSkillSection("protocol", "quark")).toContain("Evidence");
    expect(readSkillSection("dedup", "quark")).toContain("larger");
    expect(readSkillSection("nope", "quark")).toContain("Unknown skill section");
  });
});
