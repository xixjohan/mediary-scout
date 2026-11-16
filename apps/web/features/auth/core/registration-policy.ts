/**
 * 自助注册开关（`MEDIA_TRACK_ALLOW_REGISTRATION`）。
 *
 * 缺省**开放**：自托管用户第一次部署后要能自己认领实例，默认关掉会让人卡在
 * 登录页。多用户实例交给家人朋友用时，站长通常希望「账号由我建、不让人随便注册」，
 * 于是显式置 `0`。
 *
 * 关闭时**只关「新建账号」这条路径**，不关「认领」：未认领实例上的第一个用户
 * 是接管种子账号 `acct_default`（连同已有的网盘与影视库），不是创建新账号。
 * 若连它也关掉，关掉开关就会把尚未认领的实例彻底锁死——那是运维事故。
 */

/** 只有明确写 `0` / `false` / `off` 才算关闭；其余（含未设置）一律开放。 */
export function resolveRegistrationOpen(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === "0" || value === "false" || value === "off") return false;
  return true;
}
