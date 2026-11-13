import { describe, expect, it } from "vitest";
import { DEFAULT_DOMESTIC_NO_PROXY } from "./http-proxy";
import { isHostExcluded } from "@media-track/workflow";

/**
 * 出口白名单覆盖门禁（防复发）。
 *
 * 背景：视频直链的 CDN 域名由网盘动态下发。115 的下载域名是 `*.115cdn.net`，
 * 而白名单长期只写了 `.115cdn.com` —— 结果整条视频流被送进外网代理，
 * 实测首字节 2.8–3.8s（直连 0.08–0.23s）。
 *
 * 这条门禁把「每个已支持网盘至少有一个 CDN 域名被放行」变成硬约束，
 * 新增驱动时若忘记登记域名，CI 直接失败。
 */
const PROVIDER_CDN_DOMAINS: Array<{ provider: string; domain: string }> = [
  { provider: "pan115", domain: "115cdn.net" },
  { provider: "pan115", domain: "115cdn.com" },
  { provider: "quark", domain: "quark.cn" },
  { provider: "uc", domain: "uc.cn" },
  { provider: "pan123", domain: "123pan.com" },
  { provider: "alipan", domain: "alipan.com" },
];

describe("DEFAULT_DOMESTIC_NO_PROXY 覆盖门禁", () => {
  const joined = DEFAULT_DOMESTIC_NO_PROXY.join(",");

  it.each(PROVIDER_CDN_DOMAINS)("$provider 的 CDN 域名 $domain 必须直连", ({ domain }) => {
    // 用真实的 CDN 子域名形态校验，避免只登记了裸域却匹配不到子域
    expect(isHostExcluded(`cdn-edge1.${domain}`, joined)).toBe(true);
  });

  it("外网域名不得被误放行", () => {
    expect(isHostExcluded("api.themoviedb.org", joined)).toBe(false);
    expect(isHostExcluded("github.com", joined)).toBe(false);
  });
});
