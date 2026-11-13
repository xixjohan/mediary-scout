import { describe, expect, it } from "vitest";
import type { SubtitleTrackInfo } from "@media-track/contracts";
import { createSubtitleController } from "./subtitle-controller";

function sub(id: string, language: string): SubtitleTrackInfo {
  return { id, language, title: `${id}.srt`, format: "srt", type: "external", url: `/${id}` };
}

const SUBTITLES = [sub("en", "en"), sub("cht", "zh-Hant"), sub("chs", "zh-Hans")];

describe("createSubtitleController", () => {
  it("初始轨道按语言优先级选中简体中文", () => {
    const controller = createSubtitleController({ getArt: () => null, subtitles: SUBTITLES });
    expect(controller.tracks.map((t) => t.id)).toEqual(["en", "cht", "chs"]);
    expect(controller.initialTrack?.id).toBe("chs");
    expect(controller.buttonLabel()).toBe("字幕 简体中文");
  });

  it("循环顺序：当前 → 下一条 → 关闭 → 第一条", () => {
    const controller = createSubtitleController({ getArt: () => null, subtitles: SUBTITLES });
    // 初始 chs（最后一条）→ 关闭
    controller.cycle();
    expect(controller.current()).toBeNull();
    expect(controller.buttonLabel()).toBe("字幕关");
    // 关闭 → 第一条
    controller.cycle();
    expect(controller.current()?.id).toBe("en");
    controller.cycle();
    expect(controller.current()?.id).toBe("cht");
    controller.cycle();
    expect(controller.current()?.id).toBe("chs");
  });

  it("无字幕轨时循环是空操作", () => {
    const controller = createSubtitleController({ getArt: () => null, subtitles: [] });
    expect(controller.initialTrack).toBeNull();
    controller.cycle();
    expect(controller.current()).toBeNull();
  });

  it("显式关闭与按编码重挂当前轨都不抛错（无 art 时静默降级）", () => {
    const controller = createSubtitleController({ getArt: () => null, subtitles: SUBTITLES });
    expect(() => controller.apply(null)).not.toThrow();
    expect(controller.current()).toBeNull();
    expect(() => controller.apply(controller.tracks[0] ?? null, "gb18030")).not.toThrow();
    expect(controller.current()?.id).toBe("en");
  });
});
