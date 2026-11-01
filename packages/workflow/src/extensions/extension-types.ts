import type { ResourceCandidate } from "../domain/domain.js";

export type ExtensionType = "search-provider" | "metadata-provider";

export interface ExtensionManifest {
  id: string; // e.g. "ext_pansou_custom"
  name: string;
  version: string;
  type: ExtensionType;
  entry: string; // e.g. "index.js"
  author?: string;
  description?: string;
  enabled: boolean;
  configSchema?: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
}

export interface ExtensionEntity {
  manifest: ExtensionManifest;
  rootDir: string;
  createdAt: number;
  updatedAt: number;
}

export interface SandboxExecutionResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  durationMs: number;
  memoryUsageBytes?: number;
}

export interface DynamicProviderSearchInput {
  keyword: string;
  config?: Record<string, unknown>;
}

export interface DynamicProviderSearchResult {
  candidates: Array<{
    title: string;
    type: "115" | "pan115" | "quark" | "thunder" | "tianyi" | "uc" | "magnet" | "ed2k" | "manual" | "123" | "guangya" | string;
    source: string;
    payload?: Record<string, unknown>;
  }>;
}
