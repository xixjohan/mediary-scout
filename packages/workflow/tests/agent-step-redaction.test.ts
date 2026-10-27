import { describe, expect, it } from "vitest";
import { REDACTED, redactAgentStepArgs, redactSensitive } from "../src/agent-step-redaction.js";

/**
 * 脱敏是日志页（W4 L1）的前置条件，不是后续补丁。
 *
 * 断言分两类：**必须遮住的**（凭证/会话/URL/分享链）和**必须留着的**（集数、关键词、
 * 候选 ID、目录 ID、文件名）。后者同样重要——日志要能用来复盘「这一步为什么这么做」，
 * 且批次 2 的验收标准要断言 candidateId；一条「长不透明串一律遮」的规则会把 UUID 也
 * 遮掉，同时毁掉可用性和验收。
 */

describe("redactAgentStepArgs — 按键名遮", () => {
  it("cookie / token / credential / session / authorization 全遮", () => {
    const out = redactAgentStepArgs({
      cookie: "UID=1_C1_2;CID=x;SEID=y",
      refreshToken: "rt_abc",
      credential: { accessToken: "at" },
      sessionKey: "sk",
      authorization: "Bearer zzz",
      password: "hunter2",
      apiKey: "k",
    });
    for (const key of [
      "cookie",
      "refreshToken",
      "credential",
      "sessionKey",
      "authorization",
      "password",
      "apiKey",
    ]) {
      expect(out[key], `${key} 没被遮住`).toBe(REDACTED);
    }
  });

  it("嵌套在对象里的凭证也遮（递归）", () => {
    const out = redactAgentStepArgs({
      plan: { step: 2, auth: { token: "leak" }, note: "ok" },
    }) as { plan: { step: number; auth: { token: string }; note: string } };
    expect(out.plan.auth.token).toBe(REDACTED);
    expect(out.plan.step).toBe(2);
    expect(out.plan.note).toBe("ok");
  });

  it("数组里的凭证也遮", () => {
    const out = redactAgentStepArgs({ items: [{ token: "a" }, { name: "b" }] }) as {
      items: Array<{ token?: string; name?: string }>;
    };
    expect(out.items[0]!.token).toBe(REDACTED);
    expect(out.items[1]!.name).toBe("b");
  });
});

describe("redactAgentStepArgs — 按值形态遮（键名不可信）", () => {
  it("115 cookie 串即使在不敏感的键下也遮", () => {
    // 模型会自己发明参数名，不能只信键名。
    const out = redactAgentStepArgs({ blob: "UID=1_C1_2;CID=abc;SEID=def" });
    expect(out.blob).toBe(REDACTED);
  });

  it("URL 一律遮（分享链的提取码就是能力本身）", () => {
    const out = redactAgentStepArgs({
      share: "https://115.com/s/swxy8ab?password=abcd",
      magnetish: "https://example.com/x",
    });
    expect(out.share).toBe(REDACTED);
    expect(out.magnetish).toBe(REDACTED);
  });
});

describe("redactAgentStepArgs — 诊断信息必须留着", () => {
  it("集数 / 关键词 / 文件 ID / 候选 ID / 目录 ID / 文件名原样保留", () => {
    const args = {
      episodes: ["S01E13", "S04E07"],
      keyword: "复仇者联盟 4K",
      fileIds: ["12345678901234567890", "22345678901234567890"],
      candidateId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      directoryId: "3301883490360541305",
      name: "Avengers.Endgame.2019.2160p.mkv",
      section: "dead-links-black-box",
    };
    expect(redactAgentStepArgs(args)).toEqual(args);
  });

  it("不修改入参（调用方可能还要用原对象）", () => {
    const args = { cookie: "UID=1;CID=2", keep: "x" };
    const snapshot = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
    redactAgentStepArgs(args);
    expect(args).toEqual(snapshot);
  });

  it("空对象 / 非对象入参不炸", () => {
    expect(redactAgentStepArgs({})).toEqual({});
    expect(redactSensitive(null)).toBeNull();
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(undefined)).toBeUndefined();
  });

  it("cappedArgs 的 _truncated 标记原样透过（体积上限与脱敏是两件事）", () => {
    expect(redactAgentStepArgs({ _truncated: true })).toEqual({ _truncated: true });
  });
});
