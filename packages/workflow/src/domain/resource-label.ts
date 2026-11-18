/**
 * 资源标题的归一化标签（纯函数，零依赖）。
 *
 * 抽到 domain 层是因为它有两个互不相干的消费者：拒绝资源指纹（execution/user-requests）
 * 与作品身份闸门（execution/title-identity）。留在 user-requests 里会让后者拖进
 * user-requests → subscription-policy-store → subscription-policy 的依赖链，形成环。
 */

const RELEASE_NOISE =
  /\b(?:2160p|1080p|720p|480p|4k|uhd|hdr10?\+?|dv|dovi|web-?dl|webrip|bluray|blu-ray|bdrip|remux|hevc|avc|x26[45]|h\.?26[45]|aac|ddp?5\.1|atmos|flac|10bit|8bit|mkv|mp4|ts)\b/gi;

/**
 * Title normalization for the fingerprint: bracket groups, sizes, release words and
 * punctuation removed, lowercased. Deliberately aggressive — it only ever combines
 * with an exact-ish size match, never decides alone.
 */
export function normalizeResourceLabel(label: string): string {
  return label
    .replace(/[【\[(（][^】\])）]*[】\])）]/g, " ")
    .replace(/\d+(?:\.\d+)?\s*(?:gb?|mb?|tb?)\b/gi, " ")
    .replace(/\.[a-z0-9]{2,4}$/i, " ")
    .replace(RELEASE_NOISE, " ")
    .replace(/[\s._\-·:：,，、。!！?？'"]+/g, "")
    .toLowerCase();
}
