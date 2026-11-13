/**
 * 直链过期判定（纯函数）。
 *
 * 背景：网盘 CDN 的签名直链是短命的（115 实测远短于我们假设的 2 小时）。
 * 旧实现在 proxy 分支把上游 401/403/410 原样透传给播放器，且不失效缓存，
 * 于是「长片播到一半 seek / 网络重连」会一直失败到缓存 TTL 到期。
 *
 * 这里只做判定，不碰 IO，便于单测与在路由里复用。
 */

/** 上游明确表示「链接不可用」的状态码。 */
export function isExpiredLinkStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 410;
}

/**
 * 是否应当用「重新解析的新直链」重试一次。
 *
 * 只在两个条件同时成立时重试：
 * 1. 这次响应来自缓存（冷路径刚解析出来的链接立刻失效属于网盘侧故障，重试无意义）；
 * 2. 状态码属于过期语义。
 *
 * 重试次数由调用方保证「只重试一次」，避免并发 Range 请求触发重试风暴。
 */
export function shouldRetryWithFreshLink(input: {
  status: number;
  fromCache: boolean;
}): boolean {
  return input.fromCache && isExpiredLinkStatus(input.status);
}
