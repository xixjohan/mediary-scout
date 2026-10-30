"use client";

import { Film, Folder, Tv } from "lucide-react";
import type { DriveBreadcrumb, DriveDirectoryListing } from "@media-track/workflow";

interface StorageQuickCategoriesProps {
  listing: DriveDirectoryListing | null;
  currentDirId: string;
  onNavigate: (dirId: string) => void;
}

function StorageQuickCategories({
  listing,
  currentDirId,
  onNavigate,
}: StorageQuickCategoriesProps) {
  const rootId = listing?.rootCid || "0";
  return (
    <div className="storage-quick-links">
      <span className="storage-quick-label">分类快捷跳转:</span>
      <button
        type="button"
        className={`storage-quick-btn ${currentDirId === rootId ? "active" : ""}`}
        onClick={() => onNavigate(rootId)}
      >
        <Folder size={14} /> 根目录
      </button>
      {listing?.moviesCid && (
        <button
          type="button"
          className={`storage-quick-btn ${currentDirId === listing.moviesCid ? "active" : ""}`}
          onClick={() => onNavigate(listing.moviesCid!)}
        >
          <Film size={14} /> 电影
        </button>
      )}
      {listing?.tvCid && (
        <button
          type="button"
          className={`storage-quick-btn ${currentDirId === listing.tvCid ? "active" : ""}`}
          onClick={() => onNavigate(listing.tvCid!)}
        >
          <Tv size={14} /> 剧集
        </button>
      )}
      {listing?.animeCid && (
        <button
          type="button"
          className={`storage-quick-btn ${currentDirId === listing.animeCid ? "active" : ""}`}
          onClick={() => onNavigate(listing.animeCid!)}
        >
          <Film size={14} /> 动漫
        </button>
      )}
    </div>
  );
}

interface StorageBreadcrumbsProps {
  breadcrumbs: DriveBreadcrumb[];
  onNavigate: (dirId: string) => void;
}

function StorageBreadcrumbs({ breadcrumbs, onNavigate }: StorageBreadcrumbsProps) {
  if (breadcrumbs.length === 0) {
    return (
      <span className="storage-crumb-item">
        <span className="storage-crumb-sep">/</span>
        <span className="storage-crumb-current">根目录</span>
      </span>
    );
  }

  return (
    <>
      {breadcrumbs.map((crumb, idx) => {
        const isLast = idx === breadcrumbs.length - 1;
        return (
          <span key={crumb.id || idx} className="storage-crumb-item">
            <span className="storage-crumb-sep">/</span>
            {isLast ? (
              <span className="storage-crumb-current">{crumb.name}</span>
            ) : (
              <button
                type="button"
                className="storage-crumb-link"
                onClick={() => onNavigate(crumb.id)}
              >
                {crumb.name}
              </button>
            )}
          </span>
        );
      })}
    </>
  );
}

interface StorageNavBarProps {
  listing: DriveDirectoryListing | null;
  currentDirId: string;
  onNavigate: (dirId: string) => void;
}

export function StorageNavBar({ listing, currentDirId, onNavigate }: StorageNavBarProps) {
  const breadcrumbs = listing?.breadcrumbs || [];

  return (
    <div className="storage-nav-bar">
      <StorageQuickCategories
        listing={listing}
        currentDirId={currentDirId}
        onNavigate={onNavigate}
      />
      <div className="storage-breadcrumbs">
        <span className="storage-crumb-home">
          <Folder size={14} />
        </span>
        <StorageBreadcrumbs breadcrumbs={breadcrumbs} onNavigate={onNavigate} />
      </div>
    </div>
  );
}
