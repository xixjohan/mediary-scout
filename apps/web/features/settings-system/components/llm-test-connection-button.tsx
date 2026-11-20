"use client";

import { useState, useTransition } from "react";
import { testLlmConnectionAction } from "../../../app/actions/settings-system-actions";
import { runAction } from "../../../lib/run-action";

/**
 * 验证已保存的模型设置及两轮工具调用。先保存，再测试。
 */
export function LlmTestConnectionButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        className="ghost-button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await runAction(
              () => testLlmConnectionAction(),
              (msg) => setResult({ ok: false, message: msg }),
            );
            if (!r.ok) return;
            setResult(r.value);
          })
        }
      >
        {pending ? "测试中…" : "测试连接"}
      </button>
      {result ? (
        <span className={`push-help ${result.ok ? "" : "tone-amber"}`}>{result.message}</span>
      ) : null}
    </span>
  );
}
