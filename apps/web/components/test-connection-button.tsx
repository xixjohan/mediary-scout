"use client";

import { useState, useTransition } from "react";
import { testStorageConnectionAction } from "../app/actions";

/** Per-drive "测试连接" button (settings). Probes the cookie; a dead one freezes
 *  the drive server-side, and the result message tells the user to re-bind. */
export function TestConnectionButton({ storageId }: { storageId: string }) {
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
            const r = await testStorageConnectionAction(storageId);
            setResult({ ok: r.ok, message: r.message });
          })
        }
      >
        {pending ? "检测中…" : "测试连接"}
      </button>
      {result ? (
        <span className={`push-help ${result.ok ? "" : "tone-amber"}`}>{result.message}</span>
      ) : null}
    </span>
  );
}
