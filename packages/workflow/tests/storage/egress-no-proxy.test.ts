import { describe, expect, it } from "vitest";
import {
  __resetNoProxyForTests,
  ensureNoProxyHost,
  isHostExcluded,
  matchesNoProxyEntry,
  registrableDomain,
} from "../../src/storage/egress-no-proxy.js";

describe("registrableDomain", () => {
  it("取末两级作为可注册域", () => {
    expect(registrableDomain("cdnfhnfile.115cdn.net")).toBe("115cdn.net");
    expect(registrableDomain("a.b.quark.cn")).toBe("quark.cn");
  });

  it("多段后缀保留三段", () => {
    expect(registrableDomain("cdn.example.com.cn")).toBe("example.com.cn");
  });

  it("IP 与非法输入返回 null", () => {
    expect(registrableDomain("127.0.0.1")).toBeNull();
    expect(registrableDomain("[::1]")).toBeNull();
    expect(registrableDomain("localhost")).toBeNull();
  });
});

describe("matchesNoProxyEntry", () => {
  it("支持精确、点后缀与通配后缀", () => {
    expect(matchesNoProxyEntry("115cdn.net", "115cdn.net")).toBe(true);
    expect(matchesNoProxyEntry("cdnfhnfile.115cdn.net", ".115cdn.net")).toBe(true);
    expect(matchesNoProxyEntry("cdnfhnfile.115cdn.net", "*.115cdn.net")).toBe(true);
    expect(matchesNoProxyEntry("cdnfhnfile.115cdn.net", ".115cdn.com")).toBe(false);
  });

  it("后缀匹配不会误伤相似域名", () => {
    expect(matchesNoProxyEntry("evil115cdn.net", ".115cdn.net")).toBe(false);
    expect(matchesNoProxyEntry("115cdn.net.evil.com", ".115cdn.net")).toBe(false);
  });
});

describe("ensureNoProxyHost", () => {
  it("未覆盖时追加可注册域，并且幂等", () => {
    const original = process.env.NO_PROXY;
    process.env.NO_PROXY = "localhost,127.0.0.1,.115cdn.com";
    process.env.no_proxy = process.env.NO_PROXY;
    try {
      expect(ensureNoProxyHost("cdnfhnfile.115cdn.net")).toBe(true);
      expect(process.env.NO_PROXY).toContain(".115cdn.net");
      // 第二次调用不应重复追加
      expect(ensureNoProxyHost("cdn2.115cdn.net")).toBe(false);
      expect(process.env.NO_PROXY?.split(".115cdn.net").length).toBe(2);
    } finally {
      __resetNoProxyForTests(original);
    }
  });

  it("已覆盖时不改动", () => {
    const original = process.env.NO_PROXY;
    process.env.NO_PROXY = "localhost,.115cdn.net";
    try {
      expect(ensureNoProxyHost("cdnfhnfile.115cdn.net")).toBe(false);
      expect(process.env.NO_PROXY).toBe("localhost,.115cdn.net");
    } finally {
      __resetNoProxyForTests(original);
    }
  });

  it("IP 直链不做处理", () => {
    expect(ensureNoProxyHost("127.0.0.1")).toBe(false);
  });
});

describe("isHostExcluded", () => {
  it("按逗号/空格分词", () => {
    expect(isHostExcluded("cdnfhnfile.115cdn.net", "localhost .115cdn.net 127.0.0.0/8")).toBe(true);
    expect(isHostExcluded("api.themoviedb.org", "localhost,.115cdn.net")).toBe(false);
  });
});
