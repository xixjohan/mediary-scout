"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { unbindStorageAction } from "../app/actions";

/** Per-drive「取消绑定」(settings). Two-step: click → confirm. On success the
 *  drive disappears from the account; tracking data is kept (re-bind restores). */
export function UnbindStorageButton({ storageId, label }: { storageId: string; label: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  if (result?.ok) {
    return <span className="push-help">{result.message}</span>;
  }

  if (!confirming) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <button type="button" className="ghost-button" onClick={() => setConfirming(true)}>
          取消绑定
        </button>
        {result && !result.ok ? <span className="push-help tone-amber">{result.message}</span> : null}
      </span>
    );
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span className="push-help">取消绑定 {label}？追踪记录保留，重绑同盘可恢复。</span>
      <button
        type="button"
        className="secondary-button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await unbindStorageAction(storageId);
            setResult(r);
            setConfirming(false);
            if (r.ok) router.refresh();
          })
        }
      >
        {pending ? "处理中…" : "确认取消绑定"}
      </button>
      <button type="button" className="ghost-button" disabled={pending} onClick={() => setConfirming(false)}>
        返回
      </button>
    </span>
  );
}
