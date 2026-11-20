import { randomUUID } from "node:crypto";
import { generateText, stepCountIs, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { describeModelCallFailure, modelFailureMessage } from "./agent-model-diagnostics.js";

export async function probeAgentModel(model: LanguageModel, timeoutMs = 20_000): Promise<
  { ok: true; message: string } |
  { ok: false; stage: "connection" | "tool_call" | "tool_result"; message: string }
> {
  const marker = randomUUID();
  const deadline = AbortSignal.timeout(timeoutMs);
  let executions = 0;
  try {
    const result = await generateText({
      model,
      prompt: 'Call checkConnection exactly once with challenge "ping". After receiving the tool result, reply with its exact text and nothing else.',
      tools: {
        checkConnection: tool({
          description: "Returns the exact text to send back after the connection test.",
          inputSchema: z.object({ challenge: z.literal("ping") }),
          execute: async () => {
            executions += 1;
            return marker;
          },
        }),
      },
      prepareStep: ({ stepNumber }) => stepNumber === 1 ? { activeTools: [] } : undefined,
      stopWhen: [stepCountIs(2), () => executions !== 1],
      maxRetries: 0,
      abortSignal: deadline,
    });
    if (executions !== 1 || result.steps[0]?.toolCalls.length !== 1) {
      const first = result.steps[0];
      if (first && (["error", "content-filter"].includes(first.finishReason) || first.rawFinishReason === "error")) {
        return { ok: false, stage: "connection", message: "连接失败：模型请求异常结束，请检查模型设置后重试。" };
      }
      return { ok: false, stage: "tool_call", message: "模型已响应，但未能执行诊断工具。请检查模型和接口是否支持工具调用。" };
    }
    if (result.steps.length !== 2 || result.finishReason !== "stop" ||
      result.toolCalls.length !== 0 || result.text.trim() !== marker) {
      return { ok: false, stage: "tool_result", message: "工具已执行，但模型未能正确读取并返回工具结果。" };
    }
    return { ok: true, message: "连接正常 · 两轮工具调用验证通过" };
  } catch (error) {
    const { category } = describeModelCallFailure(error);
    const detail = modelFailureMessage(deadline.aborted ? "timeout" : category);
    return executions === 1
      ? { ok: false, stage: "tool_result", message: `工具已执行，第二轮验证失败：${detail}。` }
      : { ok: false, stage: "connection", message: `连接失败：${detail}。` };
  }
}
