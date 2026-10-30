#!/usr/bin/env node
// One-off: seed a few NEW-FORMAT notifications into the preview DB so the
// notifications feed (structured cards + daily-routine digest) can be eyeballed
// without a live run. Every row is prefixed `preview_demo_` so `--clean` removes
// exactly these and leaves real records untouched.
//
//   node scripts/seed-notification-preview.mjs --seed
//   node scripts/seed-notification-preview.mjs --clean

import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadDotEnv, appDbPath, openAppDb } from "./_lib/sqlite-db.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv.includes("--clean") ? "clean" : "seed";

// Pure-SQLite single engine (task S1.4b): the web app reads this same file, so
// the seeder writes to the DB the notifications UI renders from.
loadDotEnv();

const {
  createSqliteWorkflowRepository,
  createEpisodeStates,
  episodeCode,
  buildSeasonReport,
  buildSeriesReport,
  buildMovieReport,
  formatReportPushText,
} = await import(path.join(repoRoot, "packages/workflow/dist/index.js"));

const repository = createSqliteWorkflowRepository({ path: appDbPath() });

const PREFIX = "preview_demo_";

function title(id, name, type = "tv") {
  return { id: PREFIX + id, tmdbId: 900000 + id.length, type, title: name, originalTitle: name, year: 2024, aliases: [] };
}

function season(titleId, seasonNumber, totalEpisodes, latestAired) {
  return {
    id: `${PREFIX}${titleId}_s${seasonNumber}`,
    mediaTitleId: PREFIX + titleId,
    seasonNumber,
    status: latestAired >= totalEpisodes ? "completed" : "active",
    qualityPreference: "4K",
    storageDirectoryId: `${PREFIX}dir_${titleId}_${seasonNumber}`,
    totalEpisodes,
    latestAiredEpisode: latestAired,
    latestAiredSource: "metadata",
  };
}

function episodes(s, obtainedCodes) {
  const obtained = new Set(obtainedCodes);
  return createEpisodeStates({
    trackedSeasonId: s.id,
    seasonNumber: s.seasonNumber,
    totalEpisodes: s.totalEpisodes,
    latestAiredEpisode: s.latestAiredEpisode,
  }).map((ep) => ({ ...ep, obtained: obtained.has(ep.episodeCode) }));
}

function range(seasonNumber, from, to) {
  const out = [];
  for (let e = from; e <= to; e += 1) out.push(episodeCode(seasonNumber, e));
  return out;
}

async function save({ runId, t, s, eps, kind, trigger, report, createdAt }) {
  await repository.saveWorkflowRunSnapshot({
    title: t,
    season: s,
    workflowRun: {
      id: PREFIX + runId,
      kind: kind === "series_initialized" ? "type1_package_init" : trigger === "scheduled" ? "type3_monitor" : "type2_init",
      status: "succeeded",
      trackedSeasonId: s.id,
      startedAt: createdAt,
      finishedAt: createdAt,
      auditEvents: [],
    },
    episodes: eps,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [
      {
        id: `notification_${PREFIX}${runId}`,
        workflowRunId: PREFIX + runId,
        kind,
        title: report.seasonLabel ? `${report.titleName} ${report.seasonLabel}` : report.titleName,
        body: formatReportPushText(report),
        createdAt,
        trigger,
        report,
      },
    ],
  });
}

async function clean() {
  // Trigger lazy schema init so the DELETEs don't error on a fresh DB. The schema
  // has no FK constraints, so deletion order is irrelevant. The 115 cookie
  // lives in app_settings, which is never touched here.
  await repository.listNotifications({ limit: 1 });
  const db = openAppDb();
  try {
    const tables = [
      ["notifications", "workflow_run_id"],
      ["transfer_attempts", "workflow_run_id"],
      ["agent_decisions", "workflow_run_id"],
      ["resource_snapshots", "workflow_run_id"],
      ["episode_states", "tracked_season_id"],
      ["workflow_runs", "id"],
      ["tracked_seasons", "id"],
      ["media_titles", "id"],
    ];
    for (const [table, column] of tables) {
      db.prepare(`DELETE FROM ${table} WHERE ${column} LIKE ?`).run(`${PREFIX}%`);
    }
  } finally {
    db.close();
  }
  console.log("cleaned preview_demo_ rows");
}

if (mode === "clean") {
  await clean();
} else {
  const today = new Date();
  const at = (h, m) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m).toISOString();
  const yest = (h) => new Date(Date.now() - 86_400_000);
  const yAt = (h) => {
    const d = yest();
    d.setHours(h, 0, 0, 0);
    return d.toISOString();
  };

  // --- User-triggered (cards) ---
  // Type 1 series, all complete
  {
    const t = title("boys", "黑袍纠察队");
    const seasons = [1, 2, 3, 4, 5].map((n) => {
      const s = season("boys", n, 8, 8);
      return { season: s, episodes: episodes(s, range(n, 1, 8)) };
    });
    const report = buildSeriesReport({ titleName: t.title, seasons });
    await save({ runId: "boys", t, s: seasons[0].season, eps: seasons[0].episodes, kind: "series_initialized", trigger: "user", report, createdAt: at(11, 42) });
  }
  // Type 1 movie
  {
    const t = title("oppen", "奥本海默", "movie");
    const s = season("oppen", 1, 1, 1);
    const report = buildMovieReport(t.title);
    await save({ runId: "oppen", t, s, eps: episodes(s, range(1, 1, 1)), kind: "package_initialized", trigger: "user", report, createdAt: at(10, 30) });
  }
  // Type 2 single airing season, all aired obtained
  {
    const t = title("fanren", "凡人修仙传");
    const s = season("fanren", 1, 16, 12);
    const eps = episodes(s, range(1, 1, 12));
    const report = buildSeasonReport({ titleName: t.title, season: s, episodes: eps });
    await save({ runId: "fanren", t, s, eps, kind: "tracking_initialized", trigger: "user", report, createdAt: at(9, 15) });
  }

  // --- Scheduled sweep (daily digest) ---
  // restored new episode, all aired now obtained
  {
    const t = title("qiaochu", "翘楚");
    const s = season("qiaochu", 1, 20, 13);
    const eps = episodes(s, range(1, 1, 13));
    const report = buildSeasonReport({ titleName: t.title, season: s, episodes: eps, newlyObtained: [episodeCode(1, 13)] });
    await save({ runId: "qiaochu", t, s, eps, kind: "episodes_restored", trigger: "scheduled", report, createdAt: yAt(20) });
  }
  // restored + genuine aired gap
  {
    const t = title("canlan", "灿烂的她");
    const s = season("canlan", 2, 24, 10);
    const eps = episodes(s, range(2, 1, 10).filter((c) => c !== episodeCode(2, 5)));
    const report = buildSeasonReport({ titleName: t.title, season: s, episodes: eps, newlyObtained: [episodeCode(2, 10)] });
    await save({ runId: "canlan", t, s, eps, kind: "episodes_restored", trigger: "scheduled", report, createdAt: yAt(20) });
  }
  // finale — tracked airing season finished and fully obtained
  {
    const t = title("qing", "庆余年");
    const s = season("qing", 2, 36, 36);
    const eps = episodes(s, range(2, 1, 36));
    const report = buildSeasonReport({ titleName: t.title, season: s, episodes: eps });
    await save({ runId: "qing", t, s, eps, kind: "tracking_completed", trigger: "scheduled", report, createdAt: yAt(20) });
  }
  // no-change check (collapses into the digest tail)
  {
    const t = title("mist", "迷雾追踪");
    const s = season("mist", 1, 12, 8);
    const eps = episodes(s, range(1, 1, 8));
    const report = buildSeasonReport({ titleName: t.title, season: s, episodes: eps });
    await save({ runId: "mist", t, s, eps, kind: "already_current", trigger: "scheduled", report, createdAt: yAt(20) });
  }

  // --- Library "获取中" placeholder: a queued run for a real title so the
  // placeholder shows real poster art. Its season/run carry the preview prefix
  // so cleanup removes them; the real title/season are never touched.
  {
    const reals = await repository.listTrackedSeasonStates();
    // Prefer a genuinely-tracked title (real tmdbId) so its poster enriches
    // from TMDB; fall back to any tracked state.
    const real = reals.find((r) => !r.title.id.startsWith(PREFIX)) ?? reals[0];
    if (real) {
      const t = { ...real.title, id: PREFIX + "inprogress" };
      const s = season("inprogress", 1, 8, 4);
      await repository.saveWorkflowRunSnapshot({
        title: t,
        season: s,
        workflowRun: {
          id: PREFIX + "inprogress_run",
          kind: "type2_init",
          status: "running",
          trackedSeasonId: s.id,
          startedAt: at(12, 0),
          finishedAt: null,
          auditEvents: [],
        },
        episodes: episodes(s, []),
        resourceSnapshots: [],
        decisions: [],
        transferAttempts: [],
        notifications: [],
      });
      console.log(`seeded in-progress placeholder for ${t.title}`);
    }
  }

  console.log("seeded preview_demo_ notifications");
}

await repository.close();
