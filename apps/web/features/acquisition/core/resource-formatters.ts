/**
 * 资源元数据格式化纯函数（解耦组件层避免循环依赖）。
 */

import type { ResourceType } from "@media-track/workflow";

/** 字节数的人类可读形式。provider 不上报体积时整块不渲染。 */
export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatPostedAt(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().slice(0, 10);
}

/**
 * 候选的资源类型 ⇒ 用户看得懂的品牌名。
 */
export function resourceTypeLabel(type: ResourceType): string {
  switch (type) {
    case "115":
      return "115";
    case "quark":
      return "夸克";
    case "uc":
      return "UC";
    case "tianyi":
      return "天翼";
    case "123":
      return "123";
    case "guangya":
      return "光鸭";
    case "magnet":
      return "磁力";
    case "manual":
      return "手动";
  }
}
