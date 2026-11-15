import { describe, expect, it } from "vitest";
import { InMemoryDriveApiMeter } from "../../src/storage/drive-api-meter.js";

/**
 * 计量器的契约。重点：`record()` 绝不抛错（观测不能成为故障源），以及
 * 分类计数与总和自洽。
 */

describe("InMemoryDriveApiMeter", () => {
  it("按类别累加，snapshot 自洽", () => {
    const meter = new InMemoryDriveApiMeter();
    meter.record("pan115", "receiveShare"); // free
    meter.record("pan115", "addOfflineTask", "magnet:?xt=urn:btih:cafe"); // free
    meter.record("pan115", "addOfflineTask", "https://example.com/a.ass"); // download
    meter.record("pan115", "listOfflineTasks"); // download
    meter.record("pan115", "listItems"); // free
    const snap = meter.snapshot();
    expect(snap.free).toBe(3);
    expect(snap.download).toBe(2);
    expect(snap.total).toBe(5);
    expect(snap.total).toBe(snap.download + snap.free);
  });

  it("实例之间互不影响——任务内计数不跨任务累加", () => {
    const runA = new InMemoryDriveApiMeter();
    const runB = new InMemoryDriveApiMeter();
    runA.record("pan115", "listOfflineTasks");
    runA.record("pan115", "removeOfflineTask");
    expect(runA.snapshot().download).toBe(2);
    expect(runB.snapshot()).toEqual({ download: 0, free: 0, total: 0 });
  });

  it("初始快照全零", () => {
    expect(new InMemoryDriveApiMeter().snapshot()).toEqual({ download: 0, free: 0, total: 0 });
  });

  it("未登记平台计入 free", () => {
    const meter = new InMemoryDriveApiMeter();
    meter.record("quark", "getDownloadUrl");
    meter.record("quark", "listOfflineTasks");
    expect(meter.snapshot()).toEqual({ download: 0, free: 2, total: 2 });
  });

  it("record 绝不抛错——分类函数抛错时静默丢弃", () => {
    const meter = new InMemoryDriveApiMeter();
    // 用会炸的分类器验证兜底：直接调 record 传畸形入参不应抛。
    expect(() => meter.record("pan115", "addOfflineTask", undefined)).not.toThrow();
    expect(() => meter.record("pan115", "")).not.toThrow();
    expect(meter.snapshot().total).toBe(2);
  });
});
