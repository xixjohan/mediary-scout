import { describe, expect, it } from "vitest";
import {
  classifyDriveApiCall,
  classifyPan115Operation,
  hasMonthlyQuota,
  isInstantTransferUrl,
} from "../../src/storage/drive-api-quota.js";

/**
 * 分类模型的契约测试。核心是 `addOfflineTask` 的 url 协议分流——同一个操作名
 * 两类语义，分错就会把字幕的服务端拉取（有月限）误计成秒传（无月限），
 * 用户将看不到真实的额度消耗。
 */

describe("classifyPan115Operation — 磁力秒传 vs http 服务端拉取", () => {
  it("磁力 addOfflineTask 是秒传，无月限", () => {
    expect(classifyPan115Operation("addOfflineTask", "magnet:?xt=urn:btih:cafe")).toBe("free");
  });

  it("ed2k addOfflineTask 是秒传，无月限", () => {
    expect(classifyPan115Operation("addOfflineTask", "ed2k://|file|x.mkv|1|abc/")).toBe("free");
  });

  it("http 字幕离线任务是服务端拉取，有月限", () => {
    expect(classifyPan115Operation("addOfflineTask", "https://example.com/sub.ass")).toBe("download");
  });

  it("http/ftp 都算服务端拉取", () => {
    expect(classifyPan115Operation("addOfflineTask", "http://example.com/a.srt")).toBe("download");
    expect(classifyPan115Operation("addOfflineTask", "ftp://example.com/a.srt")).toBe("download");
  });

  it("协议大小写与前置空白不影响判定", () => {
    expect(classifyPan115Operation("addOfflineTask", "  MAGNET:?xt=urn:btih:cafe")).toBe("free");
    expect(classifyPan115Operation("addOfflineTask", "\nHTTPS://example.com/a.srt")).toBe("download");
  });

  it("url 缺失时保守归 download——宁可多报不可漏报", () => {
    expect(classifyPan115Operation("addOfflineTask")).toBe("download");
  });

  it("url 是无法识别的协议时保守归 download", () => {
    expect(classifyPan115Operation("addOfflineTask", "thunder://abc")).toBe("download");
  });
});

describe("classifyPan115Operation — 离线任务管理与直链", () => {
  it("listOfflineTasks / removeOfflineTask 有月限（与直链下载共享）", () => {
    expect(classifyPan115Operation("listOfflineTasks")).toBe("download");
    expect(classifyPan115Operation("removeOfflineTask")).toBe("download");
  });

  it("receiveShare 无月限", () => {
    expect(classifyPan115Operation("receiveShare")).toBe("free");
  });

  it("目录与文件管理无月限", () => {
    for (const op of ["listItems", "moveItems", "deleteItems", "renameFile", "createFolder", "getDirectoryInfo"]) {
      expect(classifyPan115Operation(op)).toBe("free");
    }
  });
});

describe("classifyDriveApiCall — 平台隔离", () => {
  it("115 按自己的映射", () => {
    expect(classifyDriveApiCall("pan115", "getDownloadUrl")).toBe("free"); // 直链解析不在 guard 操作表内，默认 free
    expect(classifyDriveApiCall("pan115", "receiveShare")).toBe("free");
  });

  it("未登记平台一律 free——不错标成有额限", () => {
    expect(classifyDriveApiCall("quark", "getDownloadUrl")).toBe("free");
    expect(classifyDriveApiCall("tianyi", "anything")).toBe("free");
    expect(classifyDriveApiCall("", "addOfflineTask", "https://x/a.srt")).toBe("free");
  });
});

describe("isInstantTransferUrl", () => {
  it("磁力与 ed2k 为秒传", () => {
    expect(isInstantTransferUrl("magnet:?xt=urn:btih:cafe")).toBe(true);
    expect(isInstantTransferUrl("ed2k://|file|a|1|h/")).toBe(true);
  });

  it("http/https/ftp 不是秒传", () => {
    expect(isInstantTransferUrl("https://example.com/a.ass")).toBe(false);
    expect(isInstantTransferUrl("ftp://example.com/a")).toBe(false);
  });
});

describe("hasMonthlyQuota", () => {
  it("只有 download 有月限", () => {
    expect(hasMonthlyQuota("download")).toBe(true);
    expect(hasMonthlyQuota("free")).toBe(false);
  });
});
