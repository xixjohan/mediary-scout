import { RuleTester } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * S5.4 lint 门禁层：local/api-auth-required 规则单测。
 * 与 apps/web/app/api/route-auth-inventory.test.ts 同源白名单：
 *   · 漏挂 requireApiAccount 的非白名单 route.ts  → 报错（红）
 *   · agent/* 漏挂 agentApiGuard                  → 报错（红）
 *   · 白名单 route.ts / 非 api 文件               → 不误伤
 */

const rulePromise = import("./eslint-local-rules.mjs");

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

const GUARDED = `import { requireApiAccount } from "../../../lib/auth-chain";
export async function GET(request) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  return new Response("ok");
}`;

describe("local/api-auth-required", () => {
  it("规则模块可加载且形状正确", async () => {
    const mod = await rulePromise;
    expect(mod.default?.rules?.["api-auth-required"]).toBeTruthy();
    expect(mod.apiAuthRequired.meta).toBeTruthy();
    expect(typeof mod.apiAuthRequired.create).toBe("function");
  });

  it("白名单与自守卫路由不误伤，漏鉴权路由判红", async () => {
    const rule = (await rulePromise).apiAuthRequired;
    ruleTester.run("api-auth-required", rule, {
      valid: [
        // 白名单：探活
        { filename: "apps/web/app/api/health/route.ts", code: "export async function GET() { return new Response('ok'); }" },
        // 白名单：登录面自身
        { filename: "apps/web/app/api/auth/token/route.ts", code: "export async function POST(request) { return new Response('ok'); }" },
        { filename: "apps/web/app/api/auth/login/route.ts", code: "export async function POST() { return new Response('ok'); }" },
        // 白名单：worker secret / updater token / owner session
        { filename: "apps/web/app/api/workflows/run-next/route.ts", code: "export async function POST() { return new Response('ok'); }" },
        { filename: "apps/web/app/api/update/hold/route.ts", code: "export async function POST() { return new Response('ok'); }" },
        { filename: "apps/web/app/api/update/status/route.ts", code: "export async function GET() { return new Response('ok'); }" },
        // 自守卫：agent/* 挂 agentApiGuard
        {
          filename: "apps/web/app/api/agent/acquire/route.ts",
          code: `import { agentApiGuard } from "../../../../lib/agent-api/guard";\nexport async function POST(request) { const denied = agentApiGuard(request); if (denied) return denied; return new Response("ok"); }`,
        },
        // 合规：非白名单路由挂了登录链
        { filename: "apps/web/app/api/activity/route.ts", code: GUARDED },
        { filename: "apps/web/app/api/115/qrcode/status/route.ts", code: GUARDED },
        // 顶层 /api/route.ts 也在管辖内（曾是两层门禁的共同盲区）
        {
          filename: "apps/web/app/api/route.ts",
          code: `import { requireApiAccount } from "../../lib/auth-chain";\nexport async function GET(request) { const gate = await requireApiAccount(request); if (gate instanceof Response) return gate; return new Response("ok"); }`,
        },
        // 非 api 目录的文件不受约束
        { filename: "apps/web/lib/auth-chain.ts", code: "export async function f() { return 1; }" },
        { filename: "apps/web/app/api/activity/route.test.ts", code: "export async function f() { return 1; }" },
      ],
      invalid: [
        // 顶层 /api/route.ts 漏挂 → 判红（盲区已补）
        {
          filename: "apps/web/app/api/route.ts",
          code: "export async function GET() { return new Response('ok'); }",
          errors: [{ messageId: "missingChain" }],
        },
        // M3：只在注释里提到 requireApiAccount → 判红（AST 判定）
        {
          filename: "apps/web/app/api/activity/route.ts",
          code: `export async function GET(request) {
  // TODO: 挂上 requireApiAccount(request) 登录链
  return new Response("ok");
}`,
          errors: [{ messageId: "missingChain" }],
        },
        // M3：只在字符串字面量里出现 requireApiAccount → 判红
        {
          filename: "apps/web/app/api/activity/route.ts",
          code: `export async function GET(request) {
  const name = "requireApiAccount";
  return new Response(name);
}`,
          errors: [{ messageId: "missingChain" }],
        },
        // M3：agent 路由只在注释里提 agentApiGuard → 判红
        {
          filename: "apps/web/app/api/agent/acquire/route.ts",
          code: `export async function POST(request) {
  // 这里本该调用 agentApiGuard(request)
  return new Response("ok");
}`,
          errors: [{ messageId: "missingAgentGuard" }],
        },
        {
          filename: "apps/web/app/api/activity/route.ts",
          code: "export async function GET(request) { return new Response('ok'); }",
          errors: [{ message: /requireApiAccount/ }],
        },
        {
          filename: "apps/web/app/api/tianyi/qrcode/status/route.ts",
          code: "export async function POST(request) { return new Response('ok'); }",
          errors: [{ message: /requireApiAccount/ }],
        },
        {
          filename: "apps/web/app/api/agent/acquire/route.ts",
          code: "export async function POST(request) { return new Response('ok'); }",
          errors: [{ message: /agentApiGuard/ }],
        },
      ],
    });
  });
});
