import { describe, expect, it } from "vitest";
import { parseMediaFileName } from "../../src/providers/media-title-parser.js";

/**
 * 任务单 S3.1（P5）：确定性文件名解析，替代让 LLM 读文件名猜集号/画质。
 * 分层：anitomy（动漫括号名）→ parse-torrent-title（欧美发行名）→ 中文正则
 * （第N集 / 尝鲜版N / 全N集 / End 完 终章标记）——治理文档的「90% 规则 + 10% AI」
 * 双轨中的规则轨。LLM 只应处理本模块明确判定不了的残余歧义。
 */
describe("parseMediaFileName", () => {
  it("动漫括号名：集号 / 季 / 分辨率 / 字幕组", () => {
    const r = parseMediaFileName("[Nekomoe kisscircle][Grantaire 1st Season][05][CHS&JP][1080P][AVC].mp4");
    expect(r.episodeCode).toBe("S01E05");
    expect(r.season).toBe(1);
    expect(r.episode).toBe(5);
    expect(r.resolution).toBe("1080p");
    expect(r.releaseGroup?.toLowerCase()).toContain("nekomoe");
  });

  it("欧美发行名：SxxExx + 分辨率 + 来源（PTN）", () => {
    const r = parseMediaFileName("The.Mandalorian.S02E05.2160p.WEB-DL.mkv");
    expect(r.episodeCode).toBe("S02E05");
    expect(r.resolution).toBe("2160p");
    expect(r.quality?.toLowerCase()).toContain("web");
  });

  it("中文「第N集」：默认季 1", () => {
    const r = parseMediaFileName("凡人修仙传 第07集 1080P.mp4");
    expect(r.episodeCode).toBe("S01E07");
    expect(r.resolution).toBe("1080p");
  });

  it("「尝鲜版N」预览集——skill.ts 里 LLM 在读的那种名", () => {
    expect(parseMediaFileName("尝鲜版09.mkv").episodeCode).toBe("S01E09");
    expect(parseMediaFileName("xx 第10集 - 尝鲜版10 End.mp4").episode).toBe(10);
  });

  it("「全N集」整包：给出总集数；End/完 标记识别为终章", () => {
    const pack = parseMediaFileName("隐秘的角落 全12集 蓝光1080P");
    expect(pack.episodeCount).toBe(12);
    expect(pack.episodeCode).toBeNull(); // 整包不是某一集
    const finale = parseMediaFileName("庆余年 第36集 完.mp4");
    expect(finale.isFinale).toBe(true);
    expect(finale.episode).toBe(36);
  });

  it("电影名：无集号，有年份", () => {
    const r = parseMediaFileName("Oppenheimer.2023.2160p.UHD.BluRay.x265.mkv");
    expect(r.episodeCode).toBeNull();
    expect(r.year).toBe(2023);
    expect(r.resolution).toBe("2160p");
  });

  it("垃圾输入：不抛异常，字段为 null", () => {
    for (const name of ["", "   ", "?????.mkv", "abc", ".mp4"]) {
      const r = parseMediaFileName(name);
      expect(r.episodeCode).toBeNull();
      expect(r.title === null || typeof r.title === "string").toBe(true);
    }
  });

  it("集号归一化：S1E5 / 1x05 → S01E05", () => {
    expect(parseMediaFileName("Show.S1E5.1080p.mkv").episodeCode).toBe("S01E05");
    expect(parseMediaFileName("Show.1x05.1080p.mkv").episodeCode).toBe("S01E05");
    expect(parseMediaFileName("Show - 05 [1080p].mkv").episodeCode).toBe("S01E05");
  });

  it("性能护栏：1000 个名字解析远低于 1 次 LLM 调用（< 2s）", () => {
    const names = Array.from({ length: 1000 }, (_, i) =>
      i % 2 === 0
        ? `[Group${i % 7}][Some Anime][${(i % 12) + 1}][CHS][1080P].mp4`
        : `Some.Show.S0${(i % 9) + 1}E${(i % 24) + 1}.2160p.WEB-DL.mkv`,
    );
    const started = Date.now();
    for (const name of names) parseMediaFileName(name);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2000);
  });
});
