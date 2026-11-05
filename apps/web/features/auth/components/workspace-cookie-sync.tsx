"use client";

import { useEffect } from "react";
import { WORKSPACE_COOKIE_NAME } from "@media-track/workflow";

export function WorkspaceCookieSync({ storageId }: { storageId?: string | null | undefined }) {
  useEffect(() => {
    if (!storageId) return;
    try {
      document.cookie = `${WORKSPACE_COOKIE_NAME}=${encodeURIComponent(storageId)}; path=/; max-age=2592000; SameSite=Lax`;
    } catch {
      // best-effort client cookie persistence
    }
  }, [storageId]);
  return null;
}
