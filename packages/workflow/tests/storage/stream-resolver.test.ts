import { describe, expect, it, vi } from "vitest";
import {
  SingleFlightStreamResolver,
  type StorageStreamResolver,
  type ResolveStreamInput,
  type ResolvedStream,
} from "../../src/storage/stream-resolver.js";

describe("SingleFlightStreamResolver", () => {
  it("folds concurrent resolveStream calls with identical key into single execution", async () => {
    let callCount = 0;
    const mockInner: StorageStreamResolver = {
      resolveStream: vi.fn().mockImplementation(async (input: ResolveStreamInput): Promise<ResolvedStream> => {
        callCount++;
        // 模拟 50ms 异步网络延迟
        await new Promise((r) => setTimeout(r, 50));
        return {
          url: `https://cdn.example.com/${input.storageId}/${input.fileId}`,
          deliveryMode: "redirect",
          expirationSeconds: 3600,
        };
      }),
    };

    const resolver = new SingleFlightStreamResolver(mockInner);

    const input = { storageId: "drive_115", fileId: "file_999" };

    // 模拟客户端 Range 嗅探同时发起 5 个并发请求
    const promises = [
      resolver.resolveStream(input),
      resolver.resolveStream(input),
      resolver.resolveStream(input),
      resolver.resolveStream(input),
      resolver.resolveStream(input),
    ];

    const results = await Promise.all(promises);

    expect(results).toHaveLength(5);
    expect(results[0]?.url).toBe("https://cdn.example.com/drive_115/file_999");
    expect(results[1]?.url).toBe("https://cdn.example.com/drive_115/file_999");
    expect(results[4]?.url).toBe("https://cdn.example.com/drive_115/file_999");

    // 关键断言：底层仅执行了 1 次解析！
    expect(callCount).toBe(1);
    expect(mockInner.resolveStream).toHaveBeenCalledTimes(1);
  });
});
