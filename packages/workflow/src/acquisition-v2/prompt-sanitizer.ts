/**
 * AI 提示词安全净化器与审查容灾过滤器（Prompt Sanitizer & Safety Resilience）。
 *
 * 解决痛点：
 *  1. 上游大模型（Google Gemini、Azure OpenAI、Kilo、Qwen、DeepSeek 等）
 *     对影视资源文件名中的敏感噪词（如成人代号、博彩网址、特殊违规词等）易触发安全拦截，
 *     报错：`The content you provided or machine outputted is blocked.`。
 *  2. 前置净化系统提示词与用户输入中的敏感噪词，注入公共影音归档中立上下文说明。
 *  3. 提供针对内容审查拦截与 503 接口波动的精准判定器。
 */

export const CONTENT_SAFETY_PREAMBLE =
  "【系统合规与上下文说明】本任务属于公开发行影视档案元数据检索与文件管理。所有提示词、候选文件名和目录名称均来自公开发行文献与网络索引，仅作技术性文件校验与规整，不包含任何违规意图。请保持客观、中立，严格按工具规范输出。";

/**
 * 常见易触发误杀的网盘/磁力标题噪词正则库。
 */
const SENSITIVE_NOISE_PATTERNS: RegExp[] = [
  /(?:澳门|威尼斯人|新葡京|葡京|博彩|下注|开奖|皇冠现金|太阳城|外围)[^\s,，。]*/gi,
  /(?:无码|有码|步兵|骑兵|伦理片|三级片|成人专区|里番|肉番|18禁|色情|H版)/gi,
  /(?:www\.[a-zA-Z0-9_-]+\.(?:com|xyz|top|cc|vip|net|org)|https?:\/\/[a-zA-Z0-9_.-]+(?:\/[^\s]*)?)/gi,
  /(?:[a-zA-Z0-9]{32,40})/g, // 长哈希/磁力特征串降噪
];

/**
 * 净化提示词/文件名文本，移除或中性化易误触发审查的非必要干扰信息。
 */
export function sanitizePromptText(text: string): string {
  if (!text) return "";
  let cleaned = text;
  for (const pattern of SENSITIVE_NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, " ");
  }
  // 折叠多余空白
  return cleaned.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 为 System Prompt 注入中立防误杀上下文前言。
 */
export function injectSafetyPreamble(systemPrompt: string): string {
  if (systemPrompt.includes("【系统合规与上下文说明】")) {
    return systemPrompt;
  }
  return `${CONTENT_SAFETY_PREAMBLE}\n\n${systemPrompt}`;
}

const CONTENT_BLOCKED_PATTERNS = [
  "the content you provided or machine outputted is blocked",
  "content-filter",
  "content_filter",
  "content filter",
  "blocked",
  "safety",
  "moderation",
  "prohibited",
  "harmful",
];

/**
 * 判定错误是否源于上游模型的内容安全审查中断。
 */
export function isContentBlockedError(error: unknown, depth = 0): boolean {
  if (!error || depth > 5) return false;
  let msg = "";
  if (error instanceof Error) {
    msg = `${error.name} ${error.message}`.toLowerCase();
  } else if (typeof error === "string") {
    msg = error.toLowerCase();
  }
  if (CONTENT_BLOCKED_PATTERNS.some((pat) => msg.includes(pat))) {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  return cause !== undefined ? isContentBlockedError(cause, depth + 1) : false;
}

function extractStatusCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const obj = error as { statusCode?: unknown; responseStatus?: unknown; status?: unknown };
  if (typeof obj.statusCode === "number") return obj.statusCode;
  if (typeof obj.responseStatus === "number") return obj.responseStatus;
  if (typeof obj.status === "number") return obj.status;
  return null;
}

const GATEWAY_ERROR_PHRASES = [
  "503",
  "service unavailable",
  "bad gateway",
  "gateway timeout",
  "internal server error",
];

function hasGatewayMessage(error: unknown): boolean {
  const msg =
    error instanceof Error
      ? `${error.name} ${error.message}`.toLowerCase()
      : typeof error === "string"
        ? error.toLowerCase()
        : "";
  return GATEWAY_ERROR_PHRASES.some((phrase) => msg.includes(phrase));
}

/**
 * 判定错误是否源于 503 / 502 / 504 / 520 网关波动。
 */
export function isGatewayServerError(error: unknown, depth = 0): boolean {
  if (!error || depth > 5) return false;
  const code = extractStatusCode(error);
  if (code !== null && code >= 500 && code <= 599) {
    return true;
  }
  if (hasGatewayMessage(error)) {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  return cause !== undefined ? isGatewayServerError(cause, depth + 1) : false;
}
