/**
 * S5.4 lint 门禁层：local/api-auth-required。
 *
 * 与 apps/web/app/api/route-auth-inventory.test.ts 同源白名单（两层兜底）：
 *   · /api/health、/api/auth/*                          —— 探活与登录面自身，免登录
 *   · /api/workflows/run-next|run-type3                 —— worker secret（workerApiGuard）
 *   · /api/update/hold|busy|status                      —— updater token / owner session
 *   · /api/agent/*                                      —— 独立 Bearer token（agentApiGuard）
 * 其余 apps/web/app/api 下的 route.ts（含顶层 /api/route.ts）必须引用
 * requireApiAccount 登录链；
 * agent/* 必须引用 agentApiGuard。新增路由忘记挂鉴权 → lint 直接红。
 *
 * 判定走 **AST**（真的有一次函数调用），不是源码文本包含：注释或字符串字面量
 * 里写 "requireApiAccount" 骗不过这条规则——两层兜底都靠它，文本包含等于没有
 * 兜底（逐维核查用探针实证过：留一行含该标识符的注释，lint 与清单测试双双放行）。
 * 只用标识符 callee，不依赖类型感知，可在 tseslint.configs.base 同一遍里跑完。
 */

const OPEN_PATTERN =
  /\/app\/api\/(health|auth\/(bootstrap|login|logout|password|register|token)|workflows\/(run-next|run-type3)|update\/(hold|busy|status))\/route\.ts$/;
const AGENT_PATTERN = /\/app\/api\/agent\/[^/]+\/route\.ts$/;
const API_ROUTE_PATTERN = /\/app\/api\/(?:.+?\/)?route\.ts$/;

/** @type {import("eslint").Rule.RuleModule} */
const apiAuthRequired = {
  meta: {
    type: "problem",
    docs: {
      description:
        "S5.4：/api 路由必须挂登录认证（health/auth/worker-secret/updater-token 白名单与 agent 独立 token 除外）",
    },
    schema: [],
    messages: {
      missingChain:
        "S5.4 违规：{{path}} 是非白名单 /api 路由，必须调用 requireApiAccount(request) 登录链（session cookie → Bearer JWT → 单用户局域网默认账号）。",
      missingAgentGuard:
        "S5.4 违规：{{path}} 是 agent /api 路由，必须调用 agentApiGuard(request) 独立 token 守卫。",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? "";
    if (!API_ROUTE_PATTERN.test(filename)) return {};

    // 「有没有真的调用」：只看 CallExpression 的 callee 标识符，注释与字符串都
    // 不是 CallExpression，天然排除。
    let callsChain = false;
    let callsAgentGuard = false;
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee?.type !== "Identifier") return;
        if (callee.name === "requireApiAccount") callsChain = true;
        if (callee.name === "agentApiGuard") callsAgentGuard = true;
      },
      "Program:exit"(node) {
        if (OPEN_PATTERN.test(filename)) return;
        if (AGENT_PATTERN.test(filename)) {
          if (!callsAgentGuard) {
            context.report({ node, messageId: "missingAgentGuard", data: { path: filename } });
          }
          return;
        }
        if (!callsChain) {
          context.report({ node, messageId: "missingChain", data: { path: filename } });
        }
      },
    };
  },
};

/** ESLint 10 的 plugins 入口要求 `plugin.rules` 映射；单测直接取这条规则本体。 */
export default { rules: { "api-auth-required": apiAuthRequired } };
export { apiAuthRequired };
