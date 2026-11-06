import { describe, expect, it, vi } from "vitest";
import { savePolicyBeforeAcquisition } from "./subscription-modal-flow";

describe("savePolicyBeforeAcquisition", () => {
  it("persists the policy before it starts the first acquisition", async () => {
    const order: string[] = [];
    const startAcquisition = vi.fn(async () => {
      order.push("acquire");
      return "queued";
    });

    await expect(
      savePolicyBeforeAcquisition(
        async () => {
          order.push("save");
          return { ok: true };
        },
        startAcquisition,
      ),
    ).resolves.toBe("queued");

    expect(order).toEqual(["save", "acquire"]);
  });

  it("does not enqueue work when saving the policy fails", async () => {
    const startAcquisition = vi.fn(async () => "queued");

    await expect(
      savePolicyBeforeAcquisition(async () => ({ ok: false, error: "保存失败" }), startAcquisition),
    ).rejects.toThrow("保存失败");
    expect(startAcquisition).not.toHaveBeenCalled();
  });
});
