import { describe, expect, it, vi } from "vitest";
import { withBrandPacing } from "../src/brand-pacing.js";

/**
 * 任务单 S3.3：给网盘 client 包一层品牌限速（治理文档参数：115 漏桶 1.2s、
 * 夸克令牌桶 3/s burst 5）。装饰器只做 pacing，不改变任何返回与 this 绑定。
 */
function fakeClient() {
  const calls: string[] = [];
  return {
    calls,
    async listItems(input: { directoryId: string }) {
      calls.push(`listItems:${input.directoryId}`);
      return [{ id: "1" }];
    },
    async moveFiles(input: { fids: string[] }) {
      calls.push(`moveFiles:${input.fids.join(",")}`);
      return { moved: input.fids };
    },
    version: "9.9.9",
  };
}

describe("withBrandPacing", () => {
  it("未登记品牌：原对象返回（零行为改变）", () => {
    const client = fakeClient();
    expect(withBrandPacing(client, "some-new-brand", { clock: () => 0, sleep: async () => {} })).toBe(client);
  });

  it("夸克（令牌桶 3/s burst 5）：前 5 发不睡，第 6 发起按 333ms 节流", async () => {
    let now = 0;
    const slept: number[] = [];
    const client = withBrandPacing(fakeClient(), "quark", {
      clock: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    for (let i = 0; i < 6; i += 1) {
      await client.listItems({ directoryId: `d${i}` });
    }
    expect(slept).toEqual([333]);
    expect(client.calls).toHaveLength(6);
  });

  it("115（漏桶 1.2s）：连续调用被强制间隔", async () => {
    let now = 0;
    const slept: number[] = [];
    const client = withBrandPacing(fakeClient(), "pan115", {
      clock: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    await client.listItems({ directoryId: "a" });
    await client.listItems({ directoryId: "b" });
    await client.listItems({ directoryId: "c" });
    expect(slept).toEqual([1200, 1200]);
  });

  it("返回值原样透传；非函数属性不受影响", async () => {
    const client = withBrandPacing(fakeClient(), "pan115", { clock: () => 0, sleep: async () => {} });
    expect(client.version).toBe("9.9.9");
    expect(await client.moveFiles({ fids: ["x", "y"] })).toEqual({ moved: ["x", "y"] });
  });

  it("this 绑定保留（方法内可见内部状态）", async () => {
    const client = withBrandPacing(fakeClient(), "pan115", { clock: () => 0, sleep: async () => {} });
    await client.listItems({ directoryId: "z" });
    expect(client.calls).toEqual(["listItems:z"]);
  });

  it("包装不缓存方法引用（每次取到的都是 pacing 后的）", async () => {
    let now = 0;
    const slept: number[] = [];
    const client = withBrandPacing(fakeClient(), "pan115", {
      clock: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    const first = client.listItems;
    const second = client.listItems;
    await first({ directoryId: "a" });
    await second({ directoryId: "b" });
    expect(slept).toEqual([1200]);
  });
});
