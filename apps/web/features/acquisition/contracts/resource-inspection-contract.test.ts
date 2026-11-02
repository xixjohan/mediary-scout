import { describe, expect, it } from "vitest";
import type { ResourceFileNode, ResourceValidityStatus } from "@media-track/workflow";
import { formatPostedAt, formatSize, resourceTypeLabel } from "../components/resource-candidate-row";

describe("Resource Formatting Helpers", () => {
  it("formatSize: 准确转换各级别存储单位", () => {
    expect(formatSize(500)).toBe("500 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(1024 * 1024 * 1024 * 2.5)).toBe("2.5 GB");
    expect(formatSize(1024 * 1024 * 1024 * 1024 * 1.8)).toBe("1.8 TB");
  });

  it("formatPostedAt: 准确提取 YYYY-MM-DD", () => {
    expect(formatPostedAt("2026-11-02T03:00:00.000Z")).toBe("2026-11-02");
    expect(formatPostedAt("invalid-date")).toBe("invalid-date");
  });

  it("resourceTypeLabel: 返回准确的品牌名", () => {
    expect(resourceTypeLabel("115")).toBe("115");
    expect(resourceTypeLabel("quark")).toBe("夸克");
    expect(resourceTypeLabel("uc")).toBe("UC");
    expect(resourceTypeLabel("magnet")).toBe("磁力");
  });
});

describe("ResourceInspection & FileNode Contract", () => {
  it("文件夹树支持递归嵌套且结构合法", () => {
    const tree: ResourceFileNode = {
      id: "root-dir",
      name: "Season 01",
      isDir: true,
      children: [
        {
          id: "ep-1",
          name: "S01E01.mkv",
          isDir: false,
          sizeBytes: 1024 * 1024 * 800,
        },
        {
          id: "ep-2",
          name: "S01E02.mkv",
          isDir: false,
          sizeBytes: 1024 * 1024 * 850,
        },
      ],
    };

    expect(tree.isDir).toBe(true);
    expect(tree.children).toHaveLength(2);
    expect(tree.children![0]!.sizeBytes).toBe(838860800);
  });

  it("有效性状态机集合包含所有预设状态", () => {
    const validStatuses: ResourceValidityStatus[] = [
      "idle",
      "probing",
      "valid",
      "invalid",
      "password_required",
      "rate_limited",
      "unknown",
    ];
    expect(validStatuses).toHaveLength(7);
  });
});
