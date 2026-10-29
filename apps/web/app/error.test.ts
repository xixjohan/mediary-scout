import { describe, expect, it } from "vitest";
import { isChunkLoadError } from "./error";

describe("isChunkLoadError detection", () => {
  it("identifies explicit ChunkLoadError by name", () => {
    const err = new Error("Failed to load chunk");
    err.name = "ChunkLoadError";
    expect(isChunkLoadError(err)).toBe(true);
  });

  it("identifies error by message containing ChunkLoadError", () => {
    const err = new Error("ChunkLoadError: Failed to load chunk /_next/static/chunks/1o6a56i1nb897.js from module 964893");
    expect(isChunkLoadError(err)).toBe(true);
  });

  it("identifies error by message containing 'Failed to load chunk'", () => {
    const err = new Error("Failed to load chunk /_next/static/chunks/abc.js");
    expect(isChunkLoadError(err)).toBe(true);
  });

  it("identifies error by message containing 'Loading chunk'", () => {
    const err = new Error("Loading chunk 123 failed.");
    expect(isChunkLoadError(err)).toBe(true);
  });

  it("returns false for ordinary application and network errors", () => {
    expect(isChunkLoadError(new Error("NetworkError: fetch failed"))).toBe(false);
    expect(isChunkLoadError(new Error("SqliteError: database is locked"))).toBe(false);
    expect(isChunkLoadError(new Error("TMDB HTTP 500"))).toBe(false);
  });
});
