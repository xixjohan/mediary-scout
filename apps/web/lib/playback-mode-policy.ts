/**
 * 播放方式锁定策略（需求 2：普通用户只能使用影视库设置的方式播放）。
 *
 * 语义是**锁层**而不是锁值：不给用户"会话级覆盖"这一层，`binding → library → global`
 * 照常生效。因此这里只回答一个问题：**这个账号有没有资格覆盖影视库配置**。
 *
 * 判据用 `storage:browse_any` 这把钥匙：网盘运维/站长持有它（能改盘上任意目录的人
 * 也应当能自选播放方式），标准成员不持有。
 *
 * 纯函数，便于表驱动测试；真正的边界在服务端（播放路由忽略 `?delivery=` 且不读
 * 账号偏好），UI 隐藏按钮只是不给无用的入口。
 */
export interface PlaybackActor {
  isMaster: boolean;
  permissions: ReadonlySet<string>;
}

export function isPlaybackModeLocked(sec: PlaybackActor | null | undefined): boolean {
  // 没有身份（外部 STRM 客户端）→ 不锁：那类请求的设备/账号语义由 STRM 任务配置决定，
  // 不属于"应用内播放器"这条需求。
  if (!sec) return false;
  if (sec.isMaster) return false;
  if (sec.permissions.has("*")) return false;
  return !sec.permissions.has("storage:browse_any");
}

/** 账号级投送偏好只在未被锁定且持有该权限时才允许生效。 */
export function shouldHonorDeliveryPreference(sec: PlaybackActor | null | undefined): boolean {
  return !isPlaybackModeLocked(sec);
}

/** 客户端 `?delivery=` 覆盖只在未被锁定时才被尊重。 */
export function shouldHonorDeliveryQuery(sec: PlaybackActor | null | undefined): boolean {
  return !isPlaybackModeLocked(sec);
}
