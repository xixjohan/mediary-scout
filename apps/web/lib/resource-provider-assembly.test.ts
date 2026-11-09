import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ADAPTER = process.env.MEDIA_TRACK_WORKFLOW_ADAPTER;

vi.mock("./demo-mode", () => ({ isDemoMode: () => false }));

function createSettingsMock(entries: Record<string, string>) {
  return {
    getSetting: async (key: string) => entries[key] ?? null,
  };
}

describe("getWorkerResourceProvider 资源提供商装配与品牌过滤矩阵", () => {
  beforeEach(() => {
    process.env.MEDIA_TRACK_WORKFLOW_ADAPTER = "pansou";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { total: 0 } }), { status: 200 }))
    );
  });

  afterEach(() => {
    if (ORIGINAL_ADAPTER === undefined) delete process.env.MEDIA_TRACK_WORKFLOW_ADAPTER;
    else process.env.MEDIA_TRACK_WORKFLOW_ADAPTER = ORIGINAL_ADAPTER;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("当未启用 pansou 适配器时，回退到 FakeResourceProvider", async () => {
    delete process.env.MEDIA_TRACK_WORKFLOW_ADAPTER;
    const { getWorkerResourceProvider } = await import("./workflow-runtime");
    const provider = await getWorkerResourceProvider(createSettingsMock({}));
    expect(provider.constructor.name).toBe("FakeResourceProvider");
  });

  it("115 网盘：当配置了 Prowlarr 时，装配 PanSou 与 Prowlarr 的 CompositeResourceProvider", async () => {
    const { getWorkerResourceProvider } = await import("./workflow-runtime");
    const settings = createSettingsMock({
      prowlarr_base_url: "http://127.0.0.1:9696",
      prowlarr_api_key: "prowlarr_secret_key",
    });
    const provider = await getWorkerResourceProvider(settings, "pan115");
    expect(provider.constructor.name).toBe("SearchProviderRegistry");

    const names = (provider as unknown as { providers: Array<{ name: string }> }).providers.map((p) => p.name);
    expect(names).toContain("pansou");
    expect(names).toContain("prowlarr");
  });

  it("115 网盘：当未配置 Prowlarr 或缺少 apiKey 时，不挂载 Prowlarr 并返回裸 PanSou 链", async () => {
    const { getWorkerResourceProvider } = await import("./workflow-runtime");
    const settings = createSettingsMock({
      prowlarr_base_url: "http://127.0.0.1:9696",
      prowlarr_api_key: "", // 缺少 key
    });
    const provider = await getWorkerResourceProvider(settings, "pan115");
    const names = (provider as unknown as { providers: Array<{ name: string }> }).providers.map((p) => p.name);
    expect(names).not.toContain("prowlarr");
  });

  it("夸克网盘 (quark)：即便配置了 Prowlarr，也绝不挂载 Prowlarr（夸克不支持磁力）", async () => {
    const { getWorkerResourceProvider } = await import("./workflow-runtime");
    const settings = createSettingsMock({
      prowlarr_base_url: "http://127.0.0.1:9696",
      prowlarr_api_key: "prowlarr_secret_key",
    });
    const provider = await getWorkerResourceProvider(settings, "quark");
    const names = (provider as unknown as { providers: Array<{ name: string }> }).providers.map((p) => p.name);
    expect(names).not.toContain("prowlarr");
  });

  it("天翼云盘 (tianyi)：不挂载 Prowlarr，仅保留天翼资源类型", async () => {
    const { getWorkerResourceProvider } = await import("./workflow-runtime");
    const settings = createSettingsMock({
      prowlarr_base_url: "http://127.0.0.1:9696",
      prowlarr_api_key: "prowlarr_secret_key",
    });
    const provider = await getWorkerResourceProvider(settings, "tianyi");
    const names = (provider as unknown as { providers: Array<{ name: string }> }).providers.map((p) => p.name);
    expect(names).not.toContain("prowlarr");
  });

  it("光鸭 (guangya)：支持磁力，配有 Prowlarr 时正确组装 CompositeProvider", async () => {
    const { getWorkerResourceProvider } = await import("./workflow-runtime");
    const settings = createSettingsMock({
      prowlarr_base_url: "http://127.0.0.1:9696",
      prowlarr_api_key: "prowlarr_secret_key",
    });
    const provider = await getWorkerResourceProvider(settings, "guangya");
    expect(provider.constructor.name).toBe("SearchProviderRegistry");
    const names = (provider as unknown as { providers: Array<{ name: string }> }).providers.map((p) => p.name);
    expect(names).toContain("pansou");
    expect(names).toContain("prowlarr");
  });

  it("123 云盘 (pan123)：支持磁力，配有 Prowlarr 时正确组装 CompositeProvider", async () => {
    const { getWorkerResourceProvider } = await import("./workflow-runtime");
    const settings = createSettingsMock({
      prowlarr_base_url: "http://127.0.0.1:9696",
      prowlarr_api_key: "prowlarr_secret_key",
    });
    const provider = await getWorkerResourceProvider(settings, "pan123");
    expect(provider.constructor.name).toBe("SearchProviderRegistry");
    const names = (provider as unknown as { providers: Array<{ name: string }> }).providers.map((p) => p.name);
    expect(names).toContain("pansou");
    expect(names).toContain("prowlarr");
  });

  it("多源聚合：同时配置 PanSou、Prowlarr 与 Haisou 时，三者均入列", async () => {
    const { getWorkerResourceProvider } = await import("./workflow-runtime");
    const settings = createSettingsMock({
      prowlarr_base_url: "http://127.0.0.1:9696",
      prowlarr_api_key: "prowlarr_secret_key",
      haisou_api_key: "idr_haisou_key",
    });
    const provider = await getWorkerResourceProvider(settings, "pan115");
    expect(provider.constructor.name).toBe("SearchProviderRegistry");
    const names = (provider as unknown as { providers: Array<{ name: string }> }).providers.map((p) => p.name);
    expect(names).toContain("pansou");
    expect(names).toContain("prowlarr");
    expect(names).toContain("haisou");
  });
});
