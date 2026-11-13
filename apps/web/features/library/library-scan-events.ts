import { EventEmitter } from "node:events";
import type { LibraryScanProgressEvent } from "@media-track/contracts";

class LibraryScanEventEmitter extends EventEmitter {
  emitProgress(event: LibraryScanProgressEvent): void {
    this.emit(`scan:${event.libraryId}`, event);
    if (event.bindingId) {
      this.emit(`scan:binding:${event.bindingId}`, event);
    }
  }

  subscribeLibrary(libraryId: string, listener: (event: LibraryScanProgressEvent) => void): () => void {
    const eventName = `scan:${libraryId}`;
    this.on(eventName, listener);
    return () => this.off(eventName, listener);
  }
}

declare global {
  var __mediaryLibraryScanEmitter: LibraryScanEventEmitter | undefined;
}

export function getLibraryScanEmitter(): LibraryScanEventEmitter {
  if (!globalThis.__mediaryLibraryScanEmitter) {
    globalThis.__mediaryLibraryScanEmitter = new LibraryScanEventEmitter();
    globalThis.__mediaryLibraryScanEmitter.setMaxListeners(100);
  }
  return globalThis.__mediaryLibraryScanEmitter;
}
