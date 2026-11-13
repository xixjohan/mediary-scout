/**
 * 播放地址构造（纯函数）。
 *
 * 单独抽出的原因：
 * 1. `pickCode` 是 115 直链解析的最优路径入参——开放平台只认它，Cookie 路径缺它会
 *    多一次 getFileInfo（叠加 1.2s 品牌限速）。这条契约必须可单测，不能只靠手测；
 * 2. 路由文件（route.ts）不允许导出非 handler 成员，无法就地单测。
 */

export interface PlayStreamUrlInput {
  storageId: string;
  fileId: string;
  fileName: string;
  pickCode?: string | null | undefined;
}

export interface PlayStreamUrls {
  /** 按投送决策直接使用的地址（proxy 模式下与 proxyUrl 相同）。 */
  streamUrl: string;
  proxyUrl: string;
}

export function buildPlayStreamUrls(input: PlayStreamUrlInput): PlayStreamUrls {
  const name = encodeURIComponent(input.fileName);
  const pickCode = input.pickCode?.trim();
  const pickCodeQuery = pickCode ? `&pickCode=${encodeURIComponent(pickCode)}` : "";
  const base = `/api/strm/play/${input.storageId}/${input.fileId}?name=${name}${pickCodeQuery}`;
  return {
    streamUrl: base,
    proxyUrl: `${base}&delivery=proxy`,
  };
}
