/**
 * 侧边栏入口可见性。
 *
 * **这不是访问控制**——真正的边界在页面守卫与 API 断言里。这里只决定"要不要浪费
 * 用户一次点击"。若把隐藏当成安全措施，任何手输 URL 都能绕过（本项目已有先例：
 * 库管理组件直接 fetch 接口，藏按钮毫无作用）。
 *
 * 纯函数且**不依赖 platform 层**（feature-core 必须保持纯净，违反会被
 * dependency-cruiser 的 feature-core-stays-pure 规则拦下）。入参是权限集合本身，
 * 由页面 / 侧边栏调用方各自解析好再传进来。
 */

export interface NavVisibility {
  storage: boolean;
  medialib: boolean;
  chat: boolean;
  settings: boolean;
}

/** 骨架屏 / 单用户默认：全部可见。骨架不知道角色，绝不能据此隐藏入口。 */
export const NAV_ALL_VISIBLE: NavVisibility = {
  storage: true,
  medialib: true,
  chat: true,
  settings: true,
};

/** 站长与单用户（通配符）→ 全部可见。 */
export function resolveVisibilityFromPermissions(permissions: ReadonlySet<string>): NavVisibility {
  if (permissions.has("*")) return NAV_ALL_VISIBLE;
  return {
    // 网盘运维页需要「浏览任意目录」这把钥匙；只有媒体库浏览权（storage:list）不够。
    storage: permissions.has("storage:browse_any"),
    // 影视库入口保留给成员：决策 1 只禁「管理面」，查看内容允许。
    medialib: permissions.has("media:detail") || permissions.has("storage:list"),
    chat: permissions.has("assistant:chat"),
    settings: permissions.has("system:settings"),
  };
}
