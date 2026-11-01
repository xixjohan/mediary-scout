import { describe, expect, it } from "vitest";
import { DebounceQueue } from "./debounce-queue.js";

describe("DebounceQueue", () => {
  it("debounces rapid successive pushes into a single batched flush", async () => {
    const flushedBatches: string[][] = [];
    const queue = new DebounceQueue<string>({
      debounceMs: 50,
      onFlush: (items) => {
        flushedBatches.push(items);
      },
    });

    queue.push("item-1");
    await new Promise((r) => setTimeout(r, 20));
    queue.push("item-2");
    await new Promise((r) => setTimeout(r, 20));
    queue.push("item-3");

    // Before debounce fires
    expect(flushedBatches.length).toBe(0);

    // Wait for debounce to complete
    await new Promise((r) => setTimeout(r, 70));

    expect(flushedBatches.length).toBe(1);
    expect(flushedBatches[0]).toEqual(["item-1", "item-2", "item-3"]);
  });

  it("deduplicates identical items based on keyFn", async () => {
    interface TaskItem {
      id: string;
      path: string;
    }

    const flushedBatches: TaskItem[][] = [];
    const queue = new DebounceQueue<TaskItem>({
      debounceMs: 40,
      keyFn: (i) => i.id,
      onFlush: (items) => {
        flushedBatches.push(items);
      },
    });

    queue.push({ id: "1", path: "/a" });
    queue.push({ id: "1", path: "/a_updated" });
    queue.push({ id: "2", path: "/b" });

    await new Promise((r) => setTimeout(r, 60));

    expect(flushedBatches.length).toBe(1);
    expect(flushedBatches[0]).toHaveLength(2);
    expect(flushedBatches[0]?.[0]?.path).toBe("/a_updated");
  });

  it("forces flush when maxWaitMs is exceeded even under continuous stream", async () => {
    const flushedBatches: string[][] = [];
    const queue = new DebounceQueue<string>({
      debounceMs: 50,
      maxWaitMs: 80,
      onFlush: (items) => {
        flushedBatches.push(items);
      },
    });

    queue.push("a");
    await new Promise((r) => setTimeout(r, 30));
    queue.push("b");
    await new Promise((r) => setTimeout(r, 30));
    queue.push("c");
    await new Promise((r) => setTimeout(r, 30)); // 30+30+30 = 90ms >= 80ms maxWaitMs

    expect(flushedBatches.length).toBeGreaterThanOrEqual(1);
    expect(flushedBatches[0]).toContain("a");
  });

  it("supports manual explicit flush", async () => {
    const flushedBatches: string[][] = [];
    const queue = new DebounceQueue<string>({
      debounceMs: 1000, // very long timer
      onFlush: (items) => {
        flushedBatches.push(items);
      },
    });

    queue.push("quick-1", "quick-2");
    expect(flushedBatches.length).toBe(0);

    await queue.flush();

    expect(flushedBatches.length).toBe(1);
    expect(flushedBatches[0]).toEqual(["quick-1", "quick-2"]);
    expect(queue.size).toBe(0);
  });

  it("supports cancel", async () => {
    const flushedBatches: string[][] = [];
    const queue = new DebounceQueue<string>({
      debounceMs: 40,
      onFlush: (items) => {
        flushedBatches.push(items);
      },
    });

    queue.push("will-cancel");
    queue.cancel();

    await new Promise((r) => setTimeout(r, 60));
    expect(flushedBatches.length).toBe(0);
    expect(queue.size).toBe(0);
  });
});
