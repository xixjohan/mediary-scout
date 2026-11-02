"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import type { ResourceFileNode } from "@media-track/workflow";
import { formatSize } from "../core/resource-formatters";

interface ResourceFolderTreeNodeProps {
  node: ResourceFileNode;
  level?: number | undefined;
}

function ResourceFolderTreeNode({ node, level = 0 }: ResourceFolderTreeNodeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const hasChildren = Boolean(node.children && node.children.length > 0);

  if (!node.isDir) {
    return (
      <div
        className="resource-tree-leaf"
        style={{ paddingLeft: `${Math.max(12, level * 18 + 12)}px` }}
      >
        <FileText size={14} className="resource-tree-file-icon" aria-hidden />
        <span className="resource-tree-file-name" title={node.name}>
          {node.name}
        </span>
        {node.sizeBytes !== undefined && (
          <span className="resource-tree-file-size">{formatSize(node.sizeBytes)}</span>
        )}
      </div>
    );
  }

  return (
    <div className="resource-tree-branch">
      <button
        type="button"
        className="resource-tree-dir-btn"
        onClick={() => setIsOpen((prev) => !prev)}
        style={{ paddingLeft: `${Math.max(12, level * 18 + 12)}px` }}
        aria-expanded={isOpen}
      >
        {hasChildren ? (
          isOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />
        ) : (
          <span className="resource-tree-indent-spacer" />
        )}
        {isOpen ? (
          <FolderOpen size={14} className="resource-tree-dir-icon" aria-hidden />
        ) : (
          <Folder size={14} className="resource-tree-dir-icon" aria-hidden />
        )}
        <span className="resource-tree-dir-name" title={node.name}>
          {node.name}
        </span>
        {node.sizeBytes !== undefined && (
          <span className="resource-tree-file-size">{formatSize(node.sizeBytes)}</span>
        )}
      </button>

      {isOpen && hasChildren && (
        <div className="resource-tree-children">
          {node.children!.map((child: ResourceFileNode) => (
            <ResourceFolderTreeNode key={child.id} node={child} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export interface ResourceFolderTreeProps {
  files?: ResourceFileNode[] | undefined;
  totalSizeBytes?: number | undefined;
  fileCount?: number | undefined;
  loading?: boolean | undefined;
  message?: string | undefined;
}

export function ResourceFolderTree({
  files,
  totalSizeBytes,
  fileCount,
  loading,
  message,
}: ResourceFolderTreeProps) {
  if (loading) {
    return (
      <div className="resource-tree-loading">
        <span className="resource-tree-spinner" aria-hidden />
        <span>正在读取网盘目录树与存活性…</span>
      </div>
    );
  }

  if (!files || files.length === 0) {
    return (
      <div className="resource-tree-empty">
        <span className="resource-tree-empty-text">
          {message || "该资源暂无目录文件列表，可直接入库或查看链接"}
        </span>
      </div>
    );
  }

  return (
    <div className="resource-folder-tree-container">
      <div className="resource-tree-header">
        <span className="resource-tree-header-count">
          包含 {fileCount ?? files.length} 个项目
        </span>
        {totalSizeBytes !== undefined && totalSizeBytes > 0 && (
          <span className="resource-tree-header-total">
            共计 {formatSize(totalSizeBytes)}
          </span>
        )}
      </div>
      <div className="resource-tree-list" role="tree">
        {files.map((node) => (
          <ResourceFolderTreeNode key={node.id} node={node} level={0} />
        ))}
      </div>
    </div>
  );
}
