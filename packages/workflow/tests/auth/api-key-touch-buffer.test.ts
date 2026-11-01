import { describe, expect, it, vi } from "vitest";
import { WriteBehindApiKeyTouchBuffer } from "../../src/auth/api-key-touch-buffer.js";
import type { ApiKeyV2Store } from "../../src/auth/api-key-v2-store.js";

describe("WriteBehindApiKeyTouchBuffer", () => {
  it("buffers multiple touches for same key and flushes in batch", async () => {
    const mockBatchTouch = vi.fn().mockResolvedValue(undefined);
    const mockStore = {
      batchTouchLastUsed: mockBatchTouch,
    } as unknown as ApiKeyV2Store;

    const buffer = new WriteBehindApiKeyTouchBuffer(mockStore, 0); // 禁用自动 timer 便于测试手工 flush

    buffer.touch("key_1", 1000);
    buffer.touch("key_1", 2000);
    buffer.touch("key_2", 1500);

    expect(buffer.getPendingCount()).toBe(2);

    await buffer.flush();

    expect(buffer.getPendingCount()).toBe(0);
    expect(mockBatchTouch).toHaveBeenCalledTimes(1);
    const batchArg = mockBatchTouch.mock.calls[0]?.[0] as Array<{ id: string; timestamp: number }>;
    expect(batchArg).toBeDefined();
    expect(batchArg).toHaveLength(2);

    const key1Item = batchArg.find((i) => i.id === "key_1");
    expect(key1Item?.timestamp).toBe(2000); // 应该保留最新时间戳
  });

  it("re-buffers items on failure to prevent data loss", async () => {
    let callCount = 0;
    const mockBatchTouch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("Database busy lock");
      return undefined;
    });

    const mockStore = {
      batchTouchLastUsed: mockBatchTouch,
    } as unknown as ApiKeyV2Store;

    const buffer = new WriteBehindApiKeyTouchBuffer(mockStore, 0);

    buffer.touch("key_fail", 1000);
    await buffer.flush();

    // 第一次 flush 失败，pending 应当被恢复
    expect(buffer.getPendingCount()).toBe(1);

    // 第二次 flush 成功
    await buffer.flush();
    expect(buffer.getPendingCount()).toBe(0);
    expect(mockBatchTouch).toHaveBeenCalledTimes(2);
  });
});
