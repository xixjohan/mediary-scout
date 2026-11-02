"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export interface EpisodeTarget {
  seasonNumber: number;
  episodeNumber: number;
  episodeCode: string; // "S01E05"
}

export interface EpisodeTargetState {
  target: EpisodeTarget | null;
  setTarget: (target: EpisodeTarget | null) => void;
  clearTarget: () => void;
  scrollToResourceSearch: () => void;
  targetAndScroll: (target: EpisodeTarget) => void;
}

const EpisodeTargetContext = createContext<EpisodeTargetState | null>(null);

function performSmoothScroll() {
  if (typeof document === "undefined") return;
  const targetElement =
    document.getElementById("title-resources") ??
    document.querySelector(".title-resources-search-bar") ??
    document.querySelector(".title-resource-panel");

  if (targetElement) {
    targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

export function EpisodeTargetProvider({ children }: { children: ReactNode }) {
  const [target, setTargetState] = useState<EpisodeTarget | null>(null);

  const setTarget = useCallback((newTarget: EpisodeTarget | null) => {
    setTargetState(newTarget);
  }, []);

  const clearTarget = useCallback(() => {
    setTargetState(null);
  }, []);

  const scrollToResourceSearch = useCallback(() => {
    performSmoothScroll();
  }, []);

  const targetAndScroll = useCallback((newTarget: EpisodeTarget) => {
    setTargetState(newTarget);
    // 延迟少许以确保 DOM 准备完毕并触发平滑滚动
    setTimeout(() => {
      performSmoothScroll();
    }, 50);
  }, []);

  const value = useMemo(
    () => ({
      target,
      setTarget,
      clearTarget,
      scrollToResourceSearch,
      targetAndScroll,
    }),
    [target, setTarget, clearTarget, scrollToResourceSearch, targetAndScroll],
  );

  return (
    <EpisodeTargetContext.Provider value={value}>
      {children}
    </EpisodeTargetContext.Provider>
  );
}

const NOOP_STATE: EpisodeTargetState = {
  target: null,
  setTarget: () => {},
  clearTarget: () => {},
  scrollToResourceSearch: () => {},
  targetAndScroll: () => {},
};

export function useEpisodeTarget(): EpisodeTargetState {
  return useContext(EpisodeTargetContext) ?? NOOP_STATE;
}
