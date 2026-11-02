import { describe, expect, it } from "vitest";
import {
  encode115DownurlPayload,
  decode115DownurlResponse,
} from "../../src/storage/pan115-downurl-cipher.js";

describe("pan115-downurl-cipher", () => {
  it("encode115DownurlPayload returns base64 data and md5 key", () => {
    const tm = "1793577108";
    const payload = JSON.stringify({ pickcode: "cs3a89o5pq02qdbx4" });
    const result = encode115DownurlPayload(payload, tm);

    expect(result.key).toBe("4657c6b69f4a2b2688741918956be66b");
    expect(typeof result.data).toBe("string");
    expect(result.data.length).toBeGreaterThan(50);
  });

  it("decode115DownurlResponse successfully decrypts 115 downurl response payload", () => {
    const liveKey = "6aaf2c31b262c0a6c87ac927254d3dbb";
    const liveServerResponse =
      "JU5p92/gmytyUv/luL/Vh/t65dt92Hr0OIPc2KFHRlZdOsU2dHwOlCtMhY5my8P01/vfbp/u4nw+NwUIr0vm9e32OtrUbnMQe4LKiAgkXcGrLBdkCya3Hbm2skHxYXCkVQVCFkAzib+5428bCk3ej7HyUWDiHihang80nizV+U0Qf0qsTiXJ8AOz2OTWf2YE5i69O+JdaFuw8JySZvm/vpCCryNtZvC197Bl6foehMCL2/O9ZfkKQbHIrtEoC6WuK3WpmqPqUNYQTuruuJvcFrozSgun0ggIW0oaU98x94pi7iD729xEsU4Iryki4MQKACz8bqWZNZUPUpam9jSBUQUpiFbsEkMv7UpX401F5voyaDH6ZdnLJE7nPRi+mp9smIY3dXq4pAyfUJwDYbGsFjvpVnCueZR6NqZkiHJkQlG8pOsB1kvDpmKB5WChh1uN+h9wVRhZK786YNQN+zxWI7l0HOAFVPTq+cJ8rEtOFTFCH/60oekGT0oa3bpKmh7+CWETvW+x1HsPItfXe/X0WHZwzODxmFt1i4CTJklZFXKtNjOnSHyjElKrC0AeiQYd3Z8H2ubdLUdSajGP1ZThf5RxcF0kdrW/nQBKVj8AoVmnm6v0LNQkwY3Db4UvjF99fiDwD8C3Efl6qkqcEHRdC9zcmt+idZjBXg8bQn4EmLhoxnnCZfwlKFoJzPb7KvvWfoY4w+gms1zXlaxL8IHante2YMbmDYkCS2UMNDURUyh+kBK7KpN9pDVa+U29fDTmwufGu/JwTrZcKeMIRG7K5dVpskwPJU9gNDCjdcXHZiRiIBlgOMIdGejMby9OYTpT6kCBEQgPnLKyk3Dh9ef5fxpnvvm3KB31YGtTavszybbNZJLsqsZwnXtG5rDfXCrFJAYoyO7InHvqgdVRYGBgDdrd99tHslvrRpnzk/R8/hPG9qxyDonMrgpEfhafZtm3vsr29grb/5HD8tkTlIvAhvhaVgGPmJjauOKWg0nHra/MB163UYBNub0xri8ZaqJeAJ+5vWNCheah2S7OF9HXCYa2A/el0+zXDxoxKU/5CTaPTEMgyeUEE0YKXboZzuAR2J3SzNuHO/LjxPcNG/Zn+QeoiiwZXXASI26pVy3fKamxT1gh0RNwI9oxHKM4KN+EiqphOH2fvEwooLRhYGyIyZz5F1uhdvrMZje8pr+qxAQ=";

    const decoded = decode115DownurlResponse(liveServerResponse, liveKey);
    const parsed = JSON.parse(decoded);
    expect(parsed).toHaveProperty("3551693272365663529");
    expect(parsed["3551693272365663529"].file_name).toContain("ドラゴンボール超");
    expect(parsed["3551693272365663529"].file_size).toBe("7421489033");
    expect(parsed["3551693272365663529"].url.url).toContain("cdnfhnfile.115cdn.net");
  });
});
