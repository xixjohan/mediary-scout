import { describe, expect, it } from "vitest";
import {
  QUOTA_EXHAUSTED_NOTE,
  annotateQuotaExhausted,
  isQuotaExhaustedMessage,
} from "../../src/storage/pan115-quota-exhausted.js";

/**
 * 配额不足识别的契约。核心是**误判方向**：把普通失败说成配额不足会让用户
 * 跑去买额度，所以识别不出时必须原样返回，不能猜。
 */

describe("isQuotaExhaustedMessage", () => {
  it("识别配额/额度类消息", () => {
    expect(isQuotaExhaustedMessage("云下载配额不足")).toBe(true);
    expect(isQuotaExhaustedMessage("配额已用完")).toBe(true);
    expect(isQuotaExhaustedMessage("额度不足")).toBe(true);
    expect(isQuotaExhaustedMessage("quota exceeded")).toBe(true);
    expect(isQuotaExhaustedMessage("Insufficient quota")).toBe(true);
    expect(isQuotaExhaustedMessage("  余额不足  ")).toBe(true);
  });

  it("普通失败不误判", () => {
    expect(isQuotaExhaustedMessage("")).toBe(false);
    expect(isQuotaExhaustedMessage("   ")).toBe(false);
    expect(isQuotaExhaustedMessage("network timeout")).toBe(false);
    expect(isQuotaExhaustedMessage("任务已存在")).toBe(false);
    expect(isQuotaExhaustedMessage("invalid share link")).toBe(false);
  });
});

describe("annotateQuotaExhausted", () => {
  it("配额消息补上统一说明并保留原始信息", () => {
    const out = annotateQuotaExhausted("云下载配额不足");
    expect(out).toContain(QUOTA_EXHAUSTED_NOTE);
    expect(out).toContain("云下载配额不足");
  });

  it("普通消息原样返回——不猜", () => {
    const msg = "network timeout";
    expect(annotateQuotaExhausted(msg)).toBe(msg);
  });
});

describe("QUOTA_EXHAUSTED_NOTE 文案纪律", () => {
  it("不出现额度数值——只说明状态，不报数字（平台侧余量不进 UI）", () => {
    // 115 是平台名，不是额度数值；这里只挡「N 次 / N% / 剩余 N」这类量。
    const withoutPlatformName = QUOTA_EXHAUSTED_NOTE.replace(/115/g, "");
    expect(withoutPlatformName).not.toMatch(/\d/);
  });

  it("说明转存不受影响——两类操作的差异是用户最需要知道的", () => {
    expect(QUOTA_EXHAUSTED_NOTE).toContain("转存不受影响");
    expect(QUOTA_EXHAUSTED_NOTE).toContain("按月限额");
  });
});
