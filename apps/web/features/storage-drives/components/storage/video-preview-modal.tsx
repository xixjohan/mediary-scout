"use client";

import type { DriveFileItem } from "@media-track/workflow";
import { MediaryPlayerModal } from "../../../player/components/mediary-player-modal";

export function VideoPreviewModal({
  item,
  storageId,
  onClose,
}: {
  item: DriveFileItem;
  storageId: string;
  onClose: () => void;
}) {
  const streamUrl = `/api/strm/play/${storageId}/${item.id}?name=${encodeURIComponent(item.name)}`;
  const proxyUrl = `/api/strm/play/${storageId}/${item.id}?name=${encodeURIComponent(item.name)}&delivery=proxy`;

  return (
    <MediaryPlayerModal
      title={item.name}
      streamUrl={streamUrl}
      proxyUrl={proxyUrl}
      onClose={onClose}
    />
  );
}
