import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dispatcher } from "undici";
import {
  CidrAwareProxyDispatcher,
  configureHttpProxyFromEnv,
  matchesNoProxyCidr,
  resolveMergedNoProxy,
} from "./http-proxy";

const originalNoProxyEnv = {
  NO_PROXY: process.env.NO_PROXY,
  no_proxy: process.env.no_proxy,
};

afterEach(() => {
  if (originalNoProxyEnv.NO_PROXY === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = originalNoProxyEnv.NO_PROXY;
  if (originalNoProxyEnv.no_proxy === undefined) delete process.env.no_proxy;
  else process.env.no_proxy = originalNoProxyEnv.no_proxy;
});

describe("configureHttpProxyFromEnv — opt-in proxy for outbound fetch (undici ignores HTTP_PROXY by default)", () => {
  it("installs an EnvHttpProxyAgent dispatcher when HTTP_PROXY is set", () => {
    const setDispatcher = vi.fn();
    const agent = { kind: "agent" } as unknown as import("undici").Dispatcher;
    const makeAgent = vi.fn(() => agent);

    const result = configureHttpProxyFromEnv(
      { HTTP_PROXY: "http://172.17.0.1:7890" },
      { setDispatcher, makeAgent },
    );

    expect(makeAgent).toHaveBeenCalledTimes(1);
    expect(setDispatcher).toHaveBeenCalledWith(agent);
    expect(result.enabled).toBe(true);
    expect(result.proxyUrl).toBe("http://172.17.0.1:7890");
  });

  it("honors HTTPS_PROXY and the lowercase variants", () => {
    for (const key of ["HTTPS_PROXY", "http_proxy", "https_proxy"]) {
      const setDispatcher = vi.fn();
      const result = configureHttpProxyFromEnv(
        { [key]: "http://proxy:8080" },
        { setDispatcher, makeAgent: () => ({}) as unknown as import("undici").Dispatcher },
      );
      expect(result.enabled, key).toBe(true);
      expect(setDispatcher, key).toHaveBeenCalledOnce();
    }
  });

  it("does NOTHING when no proxy env var is set (zero impact on the default direct-fetch path)", () => {
    const setDispatcher = vi.fn();
    const makeAgent = vi.fn();

    const result = configureHttpProxyFromEnv({}, { setDispatcher, makeAgent });

    expect(makeAgent).not.toHaveBeenCalled();
    expect(setDispatcher).not.toHaveBeenCalled();
    expect(result.enabled).toBe(false);
  });

  it("ignores a blank/whitespace-only proxy value (treats it as unset)", () => {
    const setDispatcher = vi.fn();
    const result = configureHttpProxyFromEnv(
      { HTTP_PROXY: "   " },
      { setDispatcher, makeAgent: () => ({}) as unknown as import("undici").Dispatcher },
    );
    expect(result.enabled).toBe(false);
    expect(setDispatcher).not.toHaveBeenCalled();
  });

  it("exposes a REDACTED proxy display (host:port only) so credentials never reach logs", () => {
    const result = configureHttpProxyFromEnv(
      { HTTP_PROXY: "http://user:secret@proxy.internal:7890" },
      { setDispatcher: vi.fn(), makeAgent: () => ({}) as unknown as import("undici").Dispatcher },
    );
    expect(result.enabled).toBe(true);
    expect(result.proxyDisplay).toBe("proxy.internal:7890");
    // The credentials must NOT appear anywhere in the safe display.
    expect(result.proxyDisplay).not.toContain("secret");
    expect(result.proxyDisplay).not.toContain("user");
  });

  it("proxyDisplay falls back to the raw value when it isn't a parseable URL (still no crash)", () => {
    const result = configureHttpProxyFromEnv(
      { HTTP_PROXY: "172.17.0.1:7890" },
      { setDispatcher: vi.fn(), makeAgent: () => ({}) as unknown as import("undici").Dispatcher },
    );
    expect(result.enabled).toBe(true);
    expect(result.proxyDisplay).toBe("172.17.0.1:7890");
  });

  it("adds supported domains and standard private CIDRs to NO_PROXY when proxy is enabled", () => {
    configureHttpProxyFromEnv(
      { HTTP_PROXY: "http://172.17.0.1:7890", NO_PROXY: "custom.domain" },
      { setDispatcher: vi.fn(), makeAgent: () => ({}) as unknown as import("undici").Dispatcher },
    );
    expect(process.env.NO_PROXY).toContain("custom.domain");
    expect(process.env.NO_PROXY).toContain("115.com");
    expect(process.env.NO_PROXY).toContain("quark.cn");
    expect(process.env.NO_PROXY).toContain("uc.cn");
    expect(process.env.NO_PROXY).toContain("10.0.0.0/8");
    expect(process.env.NO_PROXY).toContain("172.16.0.0/12");
    expect(process.env.NO_PROXY).toContain("192.168.0.0/16");
    expect(process.env.NO_PROXY).not.toContain("10.*");
    expect(process.env.NO_PROXY).toContain("douban.com");
  });
});

describe("CIDR-aware proxy routing", () => {
  it("preserves NO_PROXY=* as the all-host bypass rule", () => {
    expect(resolveMergedNoProxy("*")).toBe("*");
  });

  it("matches IPv4 and IPv6 CIDRs without matching addresses outside the prefix", () => {
    expect(matchesNoProxyCidr("http://10.18.2.7:5280", "10.0.0.0/8")).toBe(true);
    expect(matchesNoProxyCidr("http://172.31.255.254", "172.16.0.0/12")).toBe(true);
    expect(matchesNoProxyCidr("http://192.169.1.2", "192.168.0.0/16")).toBe(false);
    expect(matchesNoProxyCidr("http://[fd12:3456::7]:8080", "fc00::/7")).toBe(true);
    expect(matchesNoProxyCidr("http://[2001:db8::7]", "fc00::/7")).toBe(false);
    expect(matchesNoProxyCidr("http://10.18.2.7", "10.0.0.0/not-a-prefix")).toBe(false);
  });

  it("routes matching CIDR requests directly and sends other requests through the proxy dispatcher", () => {
    const directDispatcher = {
      dispatch: vi.fn(() => true),
      close: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
    } as unknown as Dispatcher;
    const proxyDispatcher = {
      dispatch: vi.fn(() => true),
      close: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
    } as unknown as Dispatcher;
    const dispatcher = new CidrAwareProxyDispatcher({
      directDispatcher,
      proxyDispatcher,
      getNoProxy: () => "10.0.0.0/8",
    });
    const handler = {} as Dispatcher.DispatchHandler;

    dispatcher.dispatch(
      { origin: "http://10.2.3.4:5280", path: "/api/health", method: "GET" } as Dispatcher.DispatchOptions,
      handler,
    );
    dispatcher.dispatch(
      { origin: "https://example.com", path: "/", method: "GET" } as Dispatcher.DispatchOptions,
      handler,
    );

    expect(directDispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(proxyDispatcher.dispatch).toHaveBeenCalledTimes(1);
  });
});
