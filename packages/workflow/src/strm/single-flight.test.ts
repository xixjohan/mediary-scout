import { describe, expect, it } from "vitest";
import { SingleFlight } from "./single-flight.js";

describe("SingleFlight", () => {
  it("coalesces concurrent requests for the same key into a single invocation", async () => {
    const sf = new SingleFlight<string>();
    let callCount = 0;

    const task = async () => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return `result-${callCount}`;
    };

    // Fire 5 concurrent requests with identical key
    const results = await Promise.all([
      sf.do("file-1", task),
      sf.do("file-1", task),
      sf.do("file-1", task),
      sf.do("file-1", task),
      sf.do("file-1", task),
    ]);

    expect(callCount).toBe(1);
    expect(results).toEqual(["result-1", "result-1", "result-1", "result-1", "result-1"]);
    expect(sf.size).toBe(0);
  });

  it("executes independently for different keys", async () => {
    const sf = new SingleFlight<string>();
    let callCount = 0;

    const task = async (key: string) => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return `${key}:${callCount}`;
    };

    const [res1, res2] = await Promise.all([
      sf.do("key-a", () => task("a")),
      sf.do("key-b", () => task("b")),
    ]);

    expect(callCount).toBe(2);
    expect(res1).toContain("a:");
    expect(res2).toContain("b:");
  });

  it("cleans up in-flight promise and allows new calls after completion", async () => {
    const sf = new SingleFlight<number>();
    let counter = 0;

    const task = async () => ++counter;

    const first = await sf.do("same-key", task);
    expect(first).toBe(1);
    expect(sf.has("same-key")).toBe(false);

    const second = await sf.do("same-key", task);
    expect(second).toBe(2);
  });

  it("propagates errors to all concurrent callers and cleans up key", async () => {
    const sf = new SingleFlight<void>();
    let attempts = 0;

    const failingTask = async () => {
      attempts++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      throw new Error("cloud-drive-429");
    };

    const results = await Promise.allSettled([
      sf.do("err-key", failingTask),
      sf.do("err-key", failingTask),
      sf.do("err-key", failingTask),
    ]);

    expect(attempts).toBe(1);
    expect(sf.size).toBe(0);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      if (r.status === "rejected") {
        expect((r.reason as Error).message).toBe("cloud-drive-429");
      }
    }
  });
});
