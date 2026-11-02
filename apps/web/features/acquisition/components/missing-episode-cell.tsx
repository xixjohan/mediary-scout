"use client";

import { parseEpisodeNumber } from "../contracts/missing-episodes-model";
import { useEpisodeTarget } from "./episode-target-context";

export interface MissingEpisodeCellProps {
  code: string;
  seasonNumber: number;
  stateClass: string;
  stateLabel: string;
}

export function MissingEpisodeCell({
  code,
  seasonNumber,
  stateClass,
  stateLabel,
}: MissingEpisodeCellProps) {
  const { target, targetAndScroll } = useEpisodeTarget();

  const episodeNumber = parseEpisodeNumber(code);
  const isTargeted =
    target?.seasonNumber === seasonNumber && target?.episodeNumber === episodeNumber;

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    targetAndScroll({
      seasonNumber,
      episodeNumber,
      episodeCode: code,
    });
  };

  return (
    <button
      type="button"
      className={`episode-cell ${stateClass} episode-cell-link ${isTargeted ? "is-targeted" : ""}`}
      onClick={handleClick}
      title={`${code} 缺集 · 点击在下方定向检索此集`}
    >
      <strong>{code.replace(/^S\d+/, "")}</strong>
      <span>{isTargeted ? "已定向" : stateLabel}</span>
    </button>
  );
}
