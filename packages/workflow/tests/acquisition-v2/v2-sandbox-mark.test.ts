import { describe, expect, it } from "vitest";
import { TaskSandbox } from "../../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../../src/acquisition-v2/storage-115-simulator.js";

const episode = (n: number) => `Show.S01E${String(n).padStart(2, "0")}.mkv`;

/** A TV task whose season dir already holds `files` — the evidence a mark needs. */
async function tvSandbox(need: string[], files: string[] = []) {
  const storage = new Storage115Simulator({
    packs: { seed: { files: files.map((path) => ({ path, sizeBytes: 9000 })) } },
  });
  const staging = await storage.createDirectory({ name: "staging", parentId: "root" });
  const season = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  if (files.length > 0) await storage.transferCandidate({ candidateId: "seed", intoDirectoryId: season });
  return new TaskSandbox({
    provider: new FakeResourceProviderV2({ results: {} }),
    storage,
    stagingDirectoryId: staging,
    targetSeasonDirectoryIds: { 1: season },
    need,
  });
}

async function movieSandbox(files: string[] = []) {
  const storage = new Storage115Simulator({
    packs: { seed: { files: files.map((path) => ({ path, sizeBytes: 9000 })) } },
  });
  const movieDir = await storage.createDirectory({ name: "Film (2023)", parentId: "root" });
  if (files.length > 0) await storage.transferCandidate({ candidateId: "seed", intoDirectoryId: movieDir });
  return new TaskSandbox({
    provider: new FakeResourceProviderV2({ results: {} }),
    storage,
    stagingDirectoryId: movieDir,
    targetMovieDirectoryId: movieDir,
    need: ["MOVIE"],
  });
}

describe("TaskSandbox — markObtained (the agent's declaration, verified against real files)", () => {
  it("records the codes the agent declares obtained, once their video is in the season dir", async () => {
    const sandbox = await tvSandbox(["S01E01", "S01E02"], [episode(1)]);

    const result = await sandbox.markObtained({ codes: ["S01E01"] });

    expect(result.confirmed).toEqual(["S01E01"]);
    const summary = await sandbox.finish();
    expect(summary.obtained).toEqual(["S01E01"]);
    expect(summary.missing).toEqual(["S01E02"]);
  });

  it("records a subtitle-fallback landing so the workflow can flag 可能无中字 (movie)", async () => {
    const sandbox = await movieSandbox(["Film.2023.mkv"]);
    await sandbox.markObtained({ codes: ["MOVIE"], subtitleFallback: true });
    const summary = await sandbox.finish();
    expect(summary.obtained).toEqual(["MOVIE"]);
    expect(summary.subtitleFallback).toBe(true);
  });

  it("a normal landing leaves subtitleFallback false", async () => {
    const sandbox = await movieSandbox(["Film.2023.mkv"]);
    await sandbox.markObtained({ codes: ["MOVIE"] });
    expect((await sandbox.finish()).subtitleFallback).toBe(false);
  });

  it("surfaces provider-ahead marks BEYOND the need — a full pack delivered past the aired cursor (#4)", async () => {
    // The live #4 bug: need = just the aired episode (S01E01, TMDB aired=1); the
    // agent transferred a coherent full-season pack and (correctly, post skill fix)
    // markObtained all 12. finish() must surface ALL the agent's marks — not just
    // need∩marked — or E02–E12 are silently dropped here, before syncSeasonNeed can
    // record them as provider-ahead (frontend "超前"). This is exactly where the
    // quark 超市 run lost E02–E12 despite marking them.
    const all = Array.from({ length: 12 }, (_, i) => `S01E${String(i + 1).padStart(2, "0")}`);
    const sandbox = await tvSandbox(["S01E01"], all.map((_, i) => episode(i + 1)));

    await sandbox.markObtained({ codes: all });

    const summary = await sandbox.finish();
    expect(summary.obtained).toEqual(all); // ALL 12, not just the aired need
    expect(summary.coverageMet).toBe(true);
  });

  it("refuses a malformed mark instead of recording it (Copilot #29)", async () => {
    // finish() feeds syncSeasonNeed → episodePartsFromCode, which THROWS on a
    // non-SxxExx token. A garbage mark has no evidence either, so the whole call
    // is refused — the valid codes in it are NOT recorded half-way.
    const sandbox = await tvSandbox(["S01E01"], [episode(1), episode(2)]);

    await expect(sandbox.markObtained({ codes: ["S01E01", "garbage", "S01E02"] })).rejects.toThrow(
      /SANDBOX_OBTAINED_NOT_VERIFIED/,
    );

    expect((await sandbox.finish()).obtained).toEqual([]);
  });

  it("orders obtained codes NUMERICALLY, not lexically (≥100 episodes — Copilot #29)", async () => {
    // Long-running shows (One Piece etc.) cross E99. A lexical sort would put
    // S01E100 before S01E99; finish() must order by (season, episode) numerically.
    const sandbox = await tvSandbox(["S01E99"], [episode(9), episode(10), episode(99), episode(100)]);

    await sandbox.markObtained({ codes: ["S01E100", "S01E09", "S01E99", "S01E10"] });

    const summary = await sandbox.finish();
    expect(summary.obtained).toEqual(["S01E09", "S01E10", "S01E99", "S01E100"]);
  });

  it("refuses a mark with no file behind it — an empty directory is not 入库", async () => {
    const sandbox = await tvSandbox(["S01E01"]);

    await expect(sandbox.markObtained({ codes: ["S01E01"] })).rejects.toThrow(/SANDBOX_OBTAINED_NOT_VERIFIED/);

    expect((await sandbox.finish()).coverageMet).toBe(false);
  });
});
