"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

interface AcquisitionLockState {
  /** Scope currently being acquired (e.g. "remaining" or "season-2"), or null. */
  acquiring: string | null;
  lock: (scope: string) => void;
}

const AcquisitionLockContext = createContext<AcquisitionLockState | null>(null);

/**
 * Shares one "an acquisition is in flight" flag across every acquisition button
 * for a single title. The instant the user fires one scope, all sibling scopes
 * disable — so "get S1" then "get S2" then "get S3" can't open three overlapping
 * requests against the same title (the backend title lock is the safety net;
 * this is the immediate UX guard).
 */
export function AcquisitionLockProvider({ children }: { children: ReactNode }) {
  const [acquiring, setAcquiring] = useState<string | null>(null);
  return (
    <AcquisitionLockContext.Provider value={{ acquiring, lock: setAcquiring }}>
      {children}
    </AcquisitionLockContext.Provider>
  );
}

export function useAcquisitionLock(): AcquisitionLockState | null {
  return useContext(AcquisitionLockContext);
}
