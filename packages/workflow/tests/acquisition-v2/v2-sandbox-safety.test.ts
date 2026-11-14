import { describe, expect, it, vi } from "vitest";
import { TaskSandbox, type TaskSandboxOptions } from "../../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator, type SimTreeFile, type TransferAttemptResult } from "../../src/acquisition-v2/storage-115-simulator.js";

async function setup(options: {
  movie?: boolean;
  titles?: string[];
  linkOf?: TaskSandboxOptions["linkOf"];
  policyFileValidator?: TaskSandboxOptions["policyFileValidator"];
} = {}) {
  const storage = new Storage115Simulator({
    packs: { a: { files: [{ path: "Film.2023.mkv", sizeBytes: 9000 }] } },
    linkKinds: { a: "share", b: "share", c: "share" },
  });
  const staging = await storage.createDirectory({ name: "staging", parentId: "root" });
  const season = await storage.createDirectory({ name: "Season 01", parentId: "root" });
  const sandbox = new TaskSandbox({
    provider: new FakeResourceProviderV2({ results: { title: (options.titles ?? ["Film", "Film B", "Film C"]).map((title, i) => ({ id: ["a", "b", "c"][i]!, title })) } }),
    storage, stagingDirectoryId: staging,
    ...(options.movie ? { targetMovieDirectoryId: staging } : { targetSeasonDirectoryIds: { 1: season } }),
    ...(options.linkOf ? { linkOf: options.linkOf } : {}),
    ...(options.policyFileValidator ? { policyFileValidator: options.policyFileValidator } : {}),
    need: options.movie ? ["MOVIE"] : ["S01E01", "S01E02"],
  });
  const snapshotId = (await sandbox.searchResources("title")).snapshot!.id;
  return { storage, sandbox, snapshotId, staging, season };
}

function video(path: string, id = path, sizeBytes = 9000): SimTreeFile {
  return { id, path, sizeBytes, isVideo: true, isSubtitle: false };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("sandbox submission safety", () => {
  it.each<TransferAttemptResult>([
    { status: "succeeded", materializedFileIds: [] },
    { status: "failed", materializedFileIds: [], noTargetChange: true },
    { status: "failed", materializedFileIds: [], providerMessage: "分享已取消" },
  ])("never resubmits a candidate without a canonical link: %j", async (attempt) => {
    const { sandbox, storage, snapshotId } = await setup();
    const transfer = vi.spyOn(storage, "transferCandidate").mockResolvedValue(attempt);
    await sandbox.transferCandidate({ snapshotId, candidateId: "a" });
    await expect(sandbox.transferCandidate({ snapshotId, candidateId: "a" })).rejects.toThrow(/SANDBOX_SAME_LINK/);
    expect(transfer).toHaveBeenCalledTimes(1);
    // A distinct candidate is not globally sealed off by a prior failed attempt.
    await sandbox.transferCandidate({ snapshotId, candidateId: "b" });
    expect(transfer).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("holds thrown submissions across both entry points (batch=%s)", async (batch) => {
    const { sandbox, storage, snapshotId } = await setup({ movie: true, linkOf: () => "pan123:same" });
    const transfer = vi.spyOn(storage, "transferCandidate").mockRejectedValue(new Error("connection lost after submit"));
    await expect(batch ? sandbox.transferUntilLanded({ candidateIds: ["a"] }) : sandbox.transferCandidate({ snapshotId, candidateId: "a" })).rejects.toThrow(/connection lost/);
    await expect(sandbox.transferCandidate({ snapshotId, candidateId: "b" })).rejects.toThrow(/SANDBOX_SAME_LINK/);
    const repeated = await sandbox.transferUntilLanded({ candidateIds: ["b", "c"] });
    expect(repeated.transferredCandidateId).toBeNull();
    expect(repeated.attempts[0]?.providerMessage).toMatch(/unresolved|未决/i);
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it("does not consume the submission when snapshot validation fails", async () => {
    const { sandbox, storage, snapshotId } = await setup();
    const transfer = vi.spyOn(storage, "transferCandidate");
    await expect(sandbox.transferCandidate({ snapshotId: "unseen", candidateId: "a" })).rejects.toThrow(/SNAPSHOT_NOT_OBSERVED/);
    await sandbox.transferCandidate({ snapshotId, candidateId: "a" });
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it("coalesces candidate reservations even without a link identity", async () => {
    const { sandbox, storage, snapshotId } = await setup();
    const gate = deferred();
    const transfer = vi.spyOn(storage, "transferCandidate").mockImplementation(async () => {
      await gate.promise;
      return { status: "succeeded", materializedFileIds: [] };
    });
    const first = sandbox.transferCandidate({ snapshotId, candidateId: "a" });
    await expect(sandbox.transferCandidate({ snapshotId, candidateId: "a" })).rejects.toThrow(/SANDBOX_SAME_LINK/);
    gate.resolve();
    await first;
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it("stops on failed-but-materialized and preserves the actual candidate and evidence", async () => {
    const { sandbox, storage } = await setup({ movie: true });
    const transfer = vi.spyOn(storage, "transferCandidate").mockResolvedValue({
      status: "failed", materializedFileIds: ["landed-a"], providerMessage: "partial response", noTargetChange: true,
    });
    vi.spyOn(storage, "listTree").mockResolvedValue([video("Film.2023.mkv", "landed-a")]);
    const result = await sandbox.transferUntilLanded({ candidateIds: ["a", "b"] });
    expect(result.transferredCandidateId).toBe("a");
    expect(result.attempts).toEqual([{ candidateId: "a", status: "failed", materializedFileIds: ["landed-a"], providerMessage: "partial response", noTargetChange: true }]);
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it("keeps noTargetChange evidence on an empty result and cannot bypass it with an alias", async () => {
    const { sandbox, storage } = await setup({ movie: true, linkOf: (id) => id === "c" ? "other" : "same" });
    const transfer = vi.spyOn(storage, "transferCandidate").mockResolvedValue({ status: "failed", materializedFileIds: [], noTargetChange: true });
    const result = await sandbox.transferUntilLanded({ candidateIds: ["a", "c"] });
    expect(result.attempts[0]).toMatchObject({ noTargetChange: true, materializedFileIds: [] });
    const again = await sandbox.transferUntilLanded({ candidateIds: ["b", "c"] });
    expect(again.transferredCandidateId).toBeNull();
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it("does not call empty succeeded evidence a landing or try the next share", async () => {
    const { sandbox, storage } = await setup({ movie: true });
    const transfer = vi.spyOn(storage, "transferCandidate").mockResolvedValue({ status: "succeeded", materializedFileIds: [] });
    const result = await sandbox.transferUntilLanded({ candidateIds: ["a", "b"] });
    expect(result.transferredCandidateId).toBeNull();
    expect(result.attempts).toEqual([{ candidateId: "a", status: "succeeded", materializedFileIds: [] }]);
    expect(transfer).toHaveBeenCalledTimes(1);
  });
});

describe("movie admission is a hard sandbox gate", () => {
  it.each(["Film 1973+1974 合集 蓝光原盘", "Film Collections", "Film 1-3 三部曲", "Film.2023.ISO", "Film/BDMV", "Film 蓝光原盘"])("refuses %s at BOTH entry points before submitting", async (title) => {
    const { sandbox, storage, snapshotId } = await setup({ movie: true, titles: [title, "Film.2023.REMUX.mkv"] });
    const transfer = vi.spyOn(storage, "transferCandidate");
    await expect(sandbox.transferCandidate({ snapshotId, candidateId: "a" })).rejects.toThrow(/SANDBOX_MOVIE_CANDIDATE_REJECTED/);
    await expect(sandbox.transferUntilLanded({ candidateIds: ["b", "a"] })).rejects.toThrow(/SANDBOX_MOVIE_CANDIDATE_REJECTED/);
    expect(transfer).not.toHaveBeenCalled();
  });

  it("allows a BluRay REMUX mkv, without changing TV multi-episode pack admission", async () => {
    const movie = await setup({ movie: true, titles: ["Film.2023.2160p.BluRay.REMUX.mkv"] });
    expect((await movie.sandbox.transferUntilLanded({ candidateIds: ["a"] })).transferredCandidateId).toBe("a");
    const tv = await setup({ titles: ["Show S01-S03 Collections 全集"] });
    expect((await tv.sandbox.transferCandidate({ snapshotId: tv.snapshotId, candidateId: "a" })).attempt.status).toBe("succeeded");
  });
});

describe("tree reads coalesce only while in flight", () => {
  it("shares simultaneous movie staging/target reads but observes a late arrival on the next read", async () => {
    const { sandbox, storage } = await setup({ movie: true });
    const gate = deferred();
    const read = vi.spyOn(storage, "listTree").mockImplementation(async () => { await gate.promise; return []; });
    const pending = Promise.all([sandbox.inspectStaging(), sandbox.inspectTargetDir()]);
    expect(read).toHaveBeenCalledTimes(1);
    gate.resolve();
    await pending;
    read.mockResolvedValue([video("Film.2023.mkv")]);
    expect(await sandbox.inspectStaging()).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("drops a rejected in-flight read, so a later read can recover", async () => {
    const { sandbox, storage } = await setup({ movie: true });
    const read = vi.spyOn(storage, "listTree").mockRejectedValueOnce(new Error("temporary listing failure")).mockResolvedValue([]);
    const results = await Promise.allSettled([sandbox.inspectStaging(), sandbox.inspectTargetDir()]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(read).toHaveBeenCalledTimes(1);
    await expect(sandbox.inspectStaging()).resolves.toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("markObtained requires final-target video evidence", () => {
  it("rejects missing, wrong-episode, unknown-episode, subtitle-only and zero-byte evidence atomically", async () => {
    const { sandbox, storage } = await setup();
    const read = vi.spyOn(storage, "listTree");
    for (const files of [[], [video("Show.S01E02.mkv")], [video("opaque.mkv")], [{ ...video("Show.S01E01.srt"), isVideo: false, isSubtitle: true }], [video("Show.S01E01.mkv", "zero", 0)]]) {
      read.mockResolvedValue(files);
      await expect(sandbox.markObtained({ codes: ["S01E01"] })).rejects.toThrow(/SANDBOX_OBTAINED_NOT_VERIFIED/);
      expect((await sandbox.finish()).obtained).toEqual([]);
    }
  });

  it("requires the right season directory, not a matching episode somewhere in staging", async () => {
    const { sandbox, storage, staging } = await setup();
    vi.spyOn(storage, "listTree").mockImplementation(async ({ directoryId }) => directoryId === staging ? [video("Show.S01E01.mkv")] : []);
    await expect(sandbox.markObtained({ codes: ["S01E01"] })).rejects.toThrow(/SANDBOX_OBTAINED_NOT_VERIFIED/);
  });

  it("reads once for a batch, confirms exact parsed episodes including provider-ahead, and rejects the entire unverified batch", async () => {
    const { sandbox, storage } = await setup();
    const read = vi.spyOn(storage, "listTree").mockResolvedValue([video("Show.S01E01.mkv"), video("Show.S01E03.mkv")]);
    await expect(sandbox.markObtained({ codes: ["S01E01", "S01E02"] })).rejects.toThrow(/SANDBOX_OBTAINED_NOT_VERIFIED/);
    expect((await sandbox.finish()).obtained).toEqual([]);
    read.mockClear();
    await expect(sandbox.markObtained({ codes: ["S01E01", "S01E03"] })).resolves.toEqual({ confirmed: ["S01E01", "S01E03"] });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    { layout: "empty", files: [] },
    { layout: "wrapped", files: [video("wrapper/Film.2023.mkv")] },
    { layout: "zero-byte", files: [video("Film.2023.mkv", "zero", 0)] },
    { layout: "trailer-only", files: [video("Film.2023.trailer.mkv")] },
    { layout: "second title", files: [video("Film.2023.mkv"), video("Other.1974.mkv")] },
  ])("refuses unverified movie layout: $layout", async ({ files }) => {
    const { sandbox, storage } = await setup({ movie: true });
    vi.spyOn(storage, "listTree").mockResolvedValue(files);
    await expect(sandbox.markObtained({ codes: ["MOVIE"], subtitleFallback: true })).rejects.toThrow(/SANDBOX_OBTAINED_NOT_VERIFIED/);
    expect(sandbox.isCoverageMet()).toBe(false);
  });

  it("accepts a nonempty flattened movie beside its subtitle", async () => {
    const { sandbox, storage } = await setup({ movie: true });
    vi.spyOn(storage, "listTree").mockResolvedValue([video("Film.2023.REMUX.mkv"), { ...video("Film.2023.srt"), isVideo: false, isSubtitle: true }]);
    await expect(sandbox.markObtained({ codes: ["MOVIE"] })).resolves.toEqual({ confirmed: ["MOVIE"] });
  });

  it("enforces policy at mark even without a prior move or remembered rejection", async () => {
    const { sandbox, storage } = await setup({ policyFileValidator: () => "missing_term" });
    vi.spyOn(storage, "listTree").mockResolvedValue([video("Show.S01E01.mkv")]);
    await expect(sandbox.markObtained({ codes: ["S01E01"] })).rejects.toThrow(/SUBSCRIPTION_POLICY_MARK_BLOCKED/);
  });
});
