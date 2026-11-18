import { formatPreviewThrottleCopy, mapPreviewResponse, type PreviewOutcome, type PreviewProgress } from "./policy-preview";

/**
 * 消费一次预览的 NDJSON 流。
 *
 * 从组件里抽出来的原因有两个：组件的复杂度预算（每个分支都是一条路径），
 * 以及「进度、完成、失败」这三类事件的分派属于协议解析，不该和 React state 缠在一起。
 * 事件来源是服务端 preview 路由：progress → done | throttled | error。
 */
export async function consumePreviewStream(
  body: ReadableStream<Uint8Array>,
  handlers: {
    onProgress: (progress: PreviewProgress) => void;
  },
): Promise<{ outcome: PreviewOutcome | null; failure: string | null; retryAfterMs: number }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outcome: PreviewOutcome | null = null;
  let failure: string | null = null;
  let retryAfterMs = 0;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (event["type"]) {
      case "progress":
        handlers.onProgress(event["progress"] as PreviewProgress);
        return;
      case "done": {
        const mapped = mapPreviewResponse(200, event);
        if (mapped.ok) outcome = mapped.outcome;
        else failure = mapped.copy;
        return;
      }
      case "throttled": {
        retryAfterMs = typeof event["retryAfterMs"] === "number" ? (event["retryAfterMs"] as number) : 60_000;
        failure = formatPreviewThrottleCopy(retryAfterMs);
        return;
      }
      case "error":
        failure = typeof event["message"] === "string" ? event["message"] : "预览失败";
        return;
      default:
        return;
    }
  };

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  }
  handleLine(buffer);
  return { outcome, failure, retryAfterMs };
}
