/**
 * 云下载配额不足的识别与表述（任务单：配额查询与错误分类）。
 *
 * 为什么需要它：115 官方对配额不足的措辞是「引导用户升级至更高的 VIP 类型或
 * 单独购买云下载配额」——配额不足是**平台级业务状态**，不是技术错误。若把它
 * 混入「转存失败」，用户看到的会是「这片子转存不了」，而真实原因是「这个月
 * 云下载额度用完了」——两者的处置动作完全不同（换资源 vs 买额度/等次月）。
 *
 * 平台未公布配额不足的专属错误码（文档仅说明 state/code/message 通用结构），
 * 因此这里按**消息文本特征**识别，并在无法识别时返回 false——宁可漏判也不
 * 误判：误判会把普通失败说成配额不足，误导用户去买额度。
 */

/** 云下载配额不足的消息特征（大小写不敏感）。 */
const QUOTA_EXHAUSTED_PATTERNS: readonly RegExp[] = [
  /配额/,
  /quota/i,
  /额度/,
  /余额不足/,
  /insufficient/i,
];

/**
 * 一条离线任务失败消息是否表示「云下载配额不足」。
 * 无法识别时返回 false——漏判只是回到通用失败表述，误判会误导用户。
 */
export function isQuotaExhaustedMessage(message: string): boolean {
  const text = message.trim();
  if (text.length === 0) return false;
  return QUOTA_EXHAUSTED_PATTERNS.some((pattern) => pattern.test(text));
}

/** 配额不足时给用户/agent 的统一表述。不含任何额度数字——平台侧余量不进 UI。 */
export const QUOTA_EXHAUSTED_NOTE =
  "云下载配额不足:本月的网盘云下载额度已用尽(115 对直链解析/离线下载按月限额,转存不限额)。" +
  "可升级 VIP 或购买云下载配额,或等下一配额周期;视频转存不受影响,仅离线下载类操作被拒。";

/** 给一条失败消息标注配额语义（识别不出时原样返回）。 */
export function annotateQuotaExhausted(message: string): string {
  return isQuotaExhaustedMessage(message) ? `${QUOTA_EXHAUSTED_NOTE}（原始信息: ${message}）` : message;
}
