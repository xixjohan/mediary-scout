"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { AcquiringDetailModal } from "./acquiring-detail-modal";
import type { InProgressTitle } from "../lib/title-hub";

export function AcquiringStatusTrigger({
  title,
  storageId,
}: {
  title: InProgressTitle;
  storageId?: string | undefined;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="secondary-button"
        onClick={() => setOpen(true)}
        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <Loader2 size={14} className="spin" aria-hidden />
        查看获取进度
      </button>

      {open ? (
        <AcquiringDetailModal
          title={title}
          storageId={storageId}
          onClose={() => setOpen(false)}
          onCancelled={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
