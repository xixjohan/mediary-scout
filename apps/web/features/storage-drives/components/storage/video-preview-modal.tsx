"use client";

import type { DriveFileItem } from "@media-track/workflow";
import { MediaryPlayerModal } from "../../../player/components/mediary-player-modal";
import { buildPlayStreamUrls } from "../../../player/play-stream-url";
import { useAuth } from "../../../auth/hooks/use-auth";

export function VideoPreviewModal({
  item,
  storageId,
  onClose,
}: {
  item: DriveFileItem;
  storageId: string;
  onClose: () => void;
}) {
  const { can } = useAuth();
  const { streamUrl, proxyUrl } = buildPlayStreamUrls({
    storageId,
    fileId: item.id,
    fileName: item.name,
    pickCode: item.pickCode,
  });

  return (
    <MediaryPlayerModal
      title={item.name}
      streamUrl={streamUrl}
      proxyUrl={proxyUrl}
      modeLocked={!can("storage:browse_any")}
      onClose={onClose}
    />
  );
}
