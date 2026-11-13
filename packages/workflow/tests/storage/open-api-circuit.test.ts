import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetOpenApiCircuitForTests,
  clearOpenApiFatal,
  markOpenApiFatal,
  shouldSkipOpenApi,
} from "../../src/storage/open-api-circuit.js";

const NOW = 1_700_000_000_000;

describe("open api circuit", () => {
  beforeEach(() => __resetOpenApiCircuitForTests());

  it("默认不熔断", () => {
    expect(shouldSkipOpenApi("cs_1", NOW)).toBe(false);
  });

  it("标记致命后冷却期内跳过", () => {
    markOpenApiFatal("cs_1", NOW);
    expect(shouldSkipOpenApi("cs_1", NOW + 60_000)).toBe(true);
    expect(shouldSkipOpenApi("cs_1", NOW + 29 * 60_000)).toBe(true);
  });

  it("冷却到期自动恢复", () => {
    markOpenApiFatal("cs_1", NOW);
    expect(shouldSkipOpenApi("cs_1", NOW + 31 * 60_000)).toBe(false);
  });

  it("按 storageId 隔离", () => {
    markOpenApiFatal("cs_1", NOW);
    expect(shouldSkipOpenApi("cs_2", NOW + 60_000)).toBe(false);
  });

  it("重新授权后可手动解除", () => {
    markOpenApiFatal("cs_1", NOW);
    clearOpenApiFatal("cs_1");
    expect(shouldSkipOpenApi("cs_1", NOW + 60_000)).toBe(false);
  });
});
