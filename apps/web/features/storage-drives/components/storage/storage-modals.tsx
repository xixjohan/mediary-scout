"use client";

import { Film, Folder, Tv } from "lucide-react";
import type { DriveDirectoryListing, DriveFileItem } from "@media-track/workflow";

export interface ModalState {
  kind: "create" | "rename" | "delete" | "move" | "copy" | null;
  singleItem?: DriveFileItem | undefined;
}

interface DestinationPickerProps {
  listing: DriveDirectoryListing;
  customTargetDir: string;
  setCustomTargetDir: (v: string) => void;
  targetDir: string;
  setTargetDir: (v: string) => void;
}

export function DestinationPicker({
  listing,
  customTargetDir,
  setCustomTargetDir,
  targetDir,
  setTargetDir,
}: DestinationPickerProps) {
  const rootId = listing.rootCid || "0";
  return (
    <div className="storage-destination-picker">
      <p className="storage-picker-title">快捷目标目录：</p>
      <div className="storage-quick-dest-row">
        <button
          type="button"
          className={`storage-quick-dest-btn ${targetDir === rootId ? "is-selected" : ""}`}
          onClick={() => {
            setTargetDir(rootId);
            setCustomTargetDir("");
          }}
        >
          <Folder size={14} /> 根目录
        </button>
        {listing.moviesCid && (
          <button
            type="button"
            className={`storage-quick-dest-btn ${targetDir === listing.moviesCid ? "is-selected" : ""}`}
            onClick={() => {
              setTargetDir(listing.moviesCid!);
              setCustomTargetDir("");
            }}
          >
            <Film size={14} /> 电影目录
          </button>
        )}
        {listing.tvCid && (
          <button
            type="button"
            className={`storage-quick-dest-btn ${targetDir === listing.tvCid ? "is-selected" : ""}`}
            onClick={() => {
              setTargetDir(listing.tvCid!);
              setCustomTargetDir("");
            }}
          >
            <Tv size={14} /> 剧集目录
          </button>
        )}
        {listing.animeCid && (
          <button
            type="button"
            className={`storage-quick-dest-btn ${targetDir === listing.animeCid ? "is-selected" : ""}`}
            onClick={() => {
              setTargetDir(listing.animeCid!);
              setCustomTargetDir("");
            }}
          >
            <Film size={14} /> 动漫目录
          </button>
        )}
      </div>

      <div className="storage-custom-target-input">
        <label htmlFor="custom-dest-input">或输入目标目录 ID：</label>
        <input
          id="custom-dest-input"
          type="text"
          value={customTargetDir}
          placeholder="例如目录 FID/CID"
          onChange={(e) => {
            const v = e.target.value.trim();
            setCustomTargetDir(v);
            if (v) setTargetDir(v);
          }}
        />
      </div>
      <p className="storage-dest-selected-hint">
        当前已选目标：<code>{targetDir || "未选择"}</code>
      </p>
    </div>
  );
}

function resolveModalTitle(kind: ModalState["kind"]): string {
  switch (kind) {
    case "create":
      return "新建文件夹";
    case "rename":
      return "重命名";
    case "delete":
      return "确认删除";
    case "move":
      return "移动项目";
    case "copy":
      return "复制项目";
    default:
      return "";
  }
}

interface ModalBodyProps {
  modal: ModalState;
  listing: DriveDirectoryListing | null;
  inputName: string;
  setInputName: (v: string) => void;
  targetDir: string;
  setTargetDir: (v: string) => void;
  customTargetDir: string;
  setCustomTargetDir: (v: string) => void;
  selectedItems: DriveFileItem[];
  onCreateFolder: () => void;
  onRename: () => void;
}

function ModalBody({
  modal,
  listing,
  inputName,
  setInputName,
  targetDir,
  setTargetDir,
  customTargetDir,
  setCustomTargetDir,
  selectedItems,
  onCreateFolder,
  onRename,
}: ModalBodyProps) {
  if (modal.kind === "create") {
    return (
      <div className="storage-modal-field">
        <label htmlFor="create-folder-input">文件夹名称：</label>
        <input
          id="create-folder-input"
          type="text"
          value={inputName}
          autoFocus
          placeholder="请输入文件夹名称"
          onChange={(e) => setInputName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onCreateFolder()}
        />
      </div>
    );
  }

  if (modal.kind === "rename") {
    return (
      <div className="storage-modal-field">
        <label htmlFor="rename-input">新名称：</label>
        <input
          id="rename-input"
          type="text"
          value={inputName}
          autoFocus
          placeholder="请输入新名称"
          onChange={(e) => setInputName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onRename()}
        />
      </div>
    );
  }

  if (modal.kind === "delete") {
    return (
      <div className="storage-delete-confirm">
        <p className="storage-delete-warning">
          ⚠️ 确定要从网盘中删除以下项目吗？此操作无法撤销。
        </p>
        <div className="storage-delete-list">
          {modal.singleItem ? (
            <p className="storage-delete-target-item">
              <strong>{modal.singleItem.name}</strong>
            </p>
          ) : (
            selectedItems.map((it) => (
              <p key={it.id} className="storage-delete-target-item">
                <span>{it.name}</span>
              </p>
            ))
          )}
        </div>
      </div>
    );
  }

  if ((modal.kind === "move" || modal.kind === "copy") && listing) {
    return (
      <DestinationPicker
        listing={listing}
        customTargetDir={customTargetDir}
        setCustomTargetDir={setCustomTargetDir}
        targetDir={targetDir}
        setTargetDir={setTargetDir}
      />
    );
  }

  return null;
}

interface ModalFooterProps {
  kind: NonNullable<ModalState["kind"]>;
  actionBusy: boolean;
  inputName: string;
  targetDir: string;
  onClose: () => void;
  onCreateFolder: () => void;
  onRename: () => void;
  onDelete: () => void;
  onMoveOrCopy: () => void;
}

function ModalFooter({
  kind,
  actionBusy,
  inputName,
  targetDir,
  onClose,
  onCreateFolder,
  onRename,
  onDelete,
  onMoveOrCopy,
}: ModalFooterProps) {
  return (
    <div className="storage-modal-footer">
      <button
        type="button"
        className="storage-btn secondary"
        onClick={onClose}
        disabled={actionBusy}
      >
        取消
      </button>

      {kind === "create" && (
        <button
          type="button"
          className="storage-btn primary"
          onClick={onCreateFolder}
          disabled={actionBusy || !inputName.trim()}
        >
          {actionBusy ? "创建中..." : "创建"}
        </button>
      )}

      {kind === "rename" && (
        <button
          type="button"
          className="storage-btn primary"
          onClick={onRename}
          disabled={actionBusy || !inputName.trim()}
        >
          {actionBusy ? "保存中..." : "保存"}
        </button>
      )}

      {kind === "delete" && (
        <button
          type="button"
          className="storage-btn batch-danger"
          onClick={onDelete}
          disabled={actionBusy}
        >
          {actionBusy ? "正在删除..." : "确认永久删除"}
        </button>
      )}

      {(kind === "move" || kind === "copy") && (
        <button
          type="button"
          className="storage-btn primary"
          onClick={onMoveOrCopy}
          disabled={actionBusy || !targetDir}
        >
          {actionBusy ? "处理中..." : kind === "move" ? "确认移动" : "确认复制"}
        </button>
      )}
    </div>
  );
}

interface StorageModalsProps {
  modal: ModalState;
  listing: DriveDirectoryListing | null;
  inputName: string;
  setInputName: (v: string) => void;
  targetDir: string;
  setTargetDir: (v: string) => void;
  customTargetDir: string;
  setCustomTargetDir: (v: string) => void;
  actionBusy: boolean;
  selectedItems: DriveFileItem[];
  onClose: () => void;
  onCreateFolder: () => void;
  onRename: () => void;
  onDelete: () => void;
  onMoveOrCopy: () => void;
}

export function StorageModals({
  modal,
  listing,
  inputName,
  setInputName,
  targetDir,
  setTargetDir,
  customTargetDir,
  setCustomTargetDir,
  actionBusy,
  selectedItems,
  onClose,
  onCreateFolder,
  onRename,
  onDelete,
  onMoveOrCopy,
}: StorageModalsProps) {
  if (!modal.kind) return null;

  return (
    <div className="acquiring-modal-backdrop" onClick={onClose}>
      <div className="acquiring-modal storage-modal" onClick={(e) => e.stopPropagation()}>
        <div className="storage-modal-header">
          <h3>{resolveModalTitle(modal.kind)}</h3>
          <button
            type="button"
            className="acquiring-modal-close"
            onClick={onClose}
            disabled={actionBusy}
          >
            ×
          </button>
        </div>

        <div className="storage-modal-body">
          <ModalBody
            modal={modal}
            listing={listing}
            inputName={inputName}
            setInputName={setInputName}
            targetDir={targetDir}
            setTargetDir={setTargetDir}
            customTargetDir={customTargetDir}
            setCustomTargetDir={setCustomTargetDir}
            selectedItems={selectedItems}
            onCreateFolder={onCreateFolder}
            onRename={onRename}
          />
        </div>

        <ModalFooter
          kind={modal.kind}
          actionBusy={actionBusy}
          inputName={inputName}
          targetDir={targetDir}
          onClose={onClose}
          onCreateFolder={onCreateFolder}
          onRename={onRename}
          onDelete={onDelete}
          onMoveOrCopy={onMoveOrCopy}
        />
      </div>
    </div>
  );
}
