import { describe, expect, it } from "vitest";
import {
  PLAYER_DELIVERY_MODE_SETTING_KEY,
  normalizePlayerDeliveryPreferenceInput,
  parsePlayerDeliveryPreference,
  toSessionOverride,
} from "../../src/strm/player-delivery-preference.js";

describe("player_delivery_mode 设置键与白名单", () => {
  it("键名固定且属于非敏感配置类", () => {
    expect(PLAYER_DELIVERY_MODE_SETTING_KEY).toBe("player_delivery_mode");
  });

  it("只接受 proxy / redirect / auto 三种值", () => {
    expect(parsePlayerDeliveryPreference("proxy")).toBe("proxy");
    expect(parsePlayerDeliveryPreference("redirect")).toBe("redirect");
    expect(parsePlayerDeliveryPreference("auto")).toBe("auto");
    expect(parsePlayerDeliveryPreference(" PROXY ")).toBe("proxy");
  });

  it("脏数据 / 注入值 / 缺失值一律视为未设置", () => {
    for (const raw of [null, undefined, "", "cover", "inherit", "redirect; DROP TABLE", "{}"]) {
      expect(parsePlayerDeliveryPreference(raw)).toBeNull();
    }
    expect(normalizePlayerDeliveryPreferenceInput({ mode: "proxy" })).toBeNull();
    expect(normalizePlayerDeliveryPreferenceInput(42)).toBeNull();
  });

  it("auto / null 不参与覆盖，proxy / redirect 成为 sessionOverride", () => {
    expect(toSessionOverride(null)).toBeNull();
    expect(toSessionOverride("auto")).toBeNull();
    expect(toSessionOverride("proxy")).toBe("proxy");
    expect(toSessionOverride("redirect")).toBe("redirect");
  });
});
