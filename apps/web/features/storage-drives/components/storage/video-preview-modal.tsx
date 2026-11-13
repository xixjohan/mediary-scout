"use client";

import type { DriveFileItem } from "@media-track/workflow";
import { MediaryPlayerModal } from "../../../player/components/mediary-player-modal";
import { buildPlayStreamUrls } from "../../../player/play-stream-url";

export function VideoPreviewModal({
  item,
  storageId,
  onClose,
}: {
  item: DriveFileItem;
  storageId: string;
  onClose: () => void;
}) {
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
      onClose={onClose}
    />
  );
}
