import { describe, expect, it } from "vitest";
import { InMemoryWorkflowRepository } from "@media-track/workflow";
import { seedDemoWorkflowRepository } from "./demo-workflow";

describe("seedDemoWorkflowRepository (expanded demo seed)", () => {
  it("seeds two drives (115 + quark) so the switcher shows", async () => {
    const repo = new InMemoryWorkflowRepository();
    await seedDemoWorkflowRepository(repo);
    const drives = await repo.listConnectedStorages("acct_default");
    expect(drives).toHaveLength(2);
    const providers = drives.map((d) => d.provider).sort();
    expect(providers).toEqual(["pan115", "quark"]);
  });

  it("seeds the tracked show + two completed movies with their runs", async () => {
    const repo = new InMemoryWorkflowRepository();
    await seedDemoWorkflowRepository(repo);
    // the three seeded runs exist
    for (const runId of ["run_demo_qiaochu", "run_demo_truman", "run_demo_shawshank"]) {
      const snap = await repo.getWorkflowRunSnapshot(runId, "acct_default");
      expect(snap, runId).not.toBeNull();
    }
  });

  it("seeds every title (show + both movies) with a real TMDB poster path so library cards render artwork", async () => {
    const repo = new InMemoryWorkflowRepository();
    await seedDemoWorkflowRepository(repo);
    const states = [
      ...(await repo.listTrackedSeasonStates({ accountId: "acct_default", connectedStorageId: "cs_demo_115" })),
      ...(await repo.listTrackedSeasonStates({ accountId: "acct_default", connectedStorageId: "cs_demo_quark" })),
    ];
    const posterByTmdb = new Map(states.map((s) => [s.title.tmdbId, s.title.posterPath]));
    // 翘楚 (tv, 289271), 楚门的世界 (movie, 37165), 肖申克的救赎 (movie, 278) — all must carry
    // a poster_path. Movies regressed: the demo previously left posterPath unset, so movie
    // cards rendered the title-text fallback instead of artwork.
    for (const tmdbId of [289271, 37165, 278]) {
      const poster = posterByTmdb.get(tmdbId);
      expect(poster, `tmdb ${tmdbId} poster_path`).toBeTruthy();
      expect(poster!.startsWith("/"), `tmdb ${tmdbId} poster looks like a TMDB path`).toBe(true);
    }
  });
});
