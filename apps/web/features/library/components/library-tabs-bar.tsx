"use client";

import { Film, Tv, FolderPlus } from "lucide-react";
import type { MediaLibrary } from "@media-track/contracts";

export interface LibraryTabsBarProps {
  libraries: MediaLibrary[];
  activeLibraryId: string;
  onSelectLibrary: (id: string) => void;
  onCreateLibrary: () => void;
}

export function LibraryTabsBar({
  libraries,
  activeLibraryId,
  onSelectLibrary,
  onCreateLibrary,
}: LibraryTabsBarProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        borderBottom: "1px solid var(--border-subtle, #27272a)",
        paddingBottom: "0.75rem",
        marginBottom: "1.25rem",
        overflowX: "auto",
      }}
    >
      <button
        type="button"
        onClick={() => onSelectLibrary("all")}
        className={`btn btn-sm ${activeLibraryId === "all" ? "btn-primary" : "btn-secondary"}`}
        style={{ borderRadius: "20px", padding: "0.35rem 1rem", flexShrink: 0 }}
      >
        全部影视
      </button>

      {libraries.map((lib) => (
        <button
          key={lib.id}
          type="button"
          onClick={() => onSelectLibrary(lib.id)}
          className={`btn btn-sm ${activeLibraryId === lib.id ? "btn-primary" : "btn-secondary"}`}
          style={{ borderRadius: "20px", padding: "0.35rem 1rem", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
        >
          {lib.libraryType === "movie" ? <Film size={14} /> : <Tv size={14} />}
          {lib.name}
        </button>
      ))}

      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={onCreateLibrary}
        style={{ borderRadius: "20px", padding: "0.35rem 0.85rem", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
      >
        <FolderPlus size={14} /> 新建库
      </button>
    </div>
  );
}
