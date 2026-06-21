"use client";

import { useEffect, useState } from "react";
import {
  DEMO_ACQUIRED_EVENT,
  listDemoAcquisitions,
  type DemoAcquisitionEntry,
} from "./demo-session";

/**
 * Live view of THIS browser session's demo acquisitions. SSR-safe: starts empty
 * (matches the server render), fills on mount, and refreshes when an acquisition
 * is recorded (DEMO_ACQUIRED_EVENT) so every mounted surface stays in sync.
 */
export function useDemoAcquisitions(): DemoAcquisitionEntry[] {
  const [entries, setEntries] = useState<DemoAcquisitionEntry[]>([]);
  useEffect(() => {
    const read = () => setEntries(listDemoAcquisitions());
    read();
    window.addEventListener(DEMO_ACQUIRED_EVENT, read);
    return () => window.removeEventListener(DEMO_ACQUIRED_EVENT, read);
  }, []);
  return entries;
}

/** The set of tmdbIds acquired this session — for acquire buttons to show 已获取. */
export function useDemoAcquiredTmdbIds(): Set<number> {
  const entries = useDemoAcquisitions();
  return new Set(entries.map((e) => e.tmdbId));
}
