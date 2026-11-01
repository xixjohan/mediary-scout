#!/usr/bin/env node
// Long-running scheduler — the GUI counterpart to the original skill's cron
// sub-agent. Two jobs:
//   • drain the acquisition queue (run-next) frequently, so a user clicking
//     "获取" actually executes shortly after;
//   • ping the 追更 sweep (run-type3) on a coarse interval. The endpoint itself
//     owns the schedule: it runs the sweep at most once per Beijing day, only
//     after the user-configured time (Settings → 每日定时巡检, default 06:00). So
//     this just has to ping often enough to land soon after that time — the
//     configured time, not this interval, decides WHEN the sweep runs.
//
//   node scripts/scheduler.mjs            # run forever
//   MEDIA_TRACK_SCHEDULER_ONCE=1 node scripts/scheduler.mjs   # one pass, exit
//
// Env:
//   MEDIA_TRACK_BASE_URL                default http://localhost:3000
//   MEDIA_TRACK_WORKER_SECRET           sent as x-media-track-worker-secret if set
//   MEDIA_TRACK_RUN_NEXT_INTERVAL_MS    default 15000   (drain acquisition queue)
//   MEDIA_TRACK_TYPE3_PING_INTERVAL_MS  default 600000  (ping the gated sweep, 10m)
//   MEDIA_TRACK_SCHEDULER_ONCE          "1" → run both once and exit (cron-friendly)

const BASE = (process.env.MEDIA_TRACK_WEB_BASE ?? process.env.MEDIA_TRACK_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SECRET = process.env.MEDIA_TRACK_WORKER_SECRET;
const NEXT_INTERVAL = Number(process.env.MEDIA_TRACK_WORKER_POLL_MS ?? process.env.MEDIA_TRACK_RUN_NEXT_INTERVAL_MS ?? 15_000);
const TYPE3_PING_INTERVAL = Number(process.env.MEDIA_TRACK_WORKER_SWEEP_MS ?? process.env.MEDIA_TRACK_TYPE3_PING_INTERVAL_MS ?? 10 * 60_000);
const ONCE = process.env.MEDIA_TRACK_SCHEDULER_ONCE === "1";

const headers = SECRET ? { "x-media-track-worker-secret": SECRET } : {};

function ts() {
  return new Date().toISOString().slice(11, 19);
}

async function post(path) {
  try {
    const res = await fetch(BASE + path, { method: "POST", headers });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

let draining = false;
// Claim-one-at-a-time worker: keep calling until the queue reports idle.
async function drainQueue() {
  if (draining) return;
  draining = true;
  try {
    for (let i = 0; i < 50; i += 1) {
      const result = await post("/api/workflows/run-next");
      if (!result.ok) {
        console.log(`[${ts()}] run-next error: ${result.error ?? result.status}`);
        return;
      }
      if (result.body?.status === "idle") return;
      console.log(`[${ts()}] run-next: ${result.body?.status ?? "?"} ${result.body?.workflowRunId ?? ""}`.trim());
    }
  } finally {
    draining = false;
  }
}

let sweeping = false;
// Ping the gated sweep. The endpoint no-ops (skipped) until the configured time,
// so pinging on an interval is safe and cheap — no time logic needed here.
async function pingSweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const result = await post("/api/workflows/run-type3");
    if (!result.ok) {
      console.log(`[${ts()}] run-type3 error: ${result.error ?? result.status}`);
      return;
    }
    if (result.body?.skipped) {
      return; // not yet the configured time, or already swept today — stay quiet
    }
    const count = Array.isArray(result.body?.outcomes) ? result.body.outcomes.length : 0;
    console.log(`[${ts()}] run-type3 sweep: ${count} season(s) processed`);
  } finally {
    sweeping = false;
  }
}

async function main() {
  if (ONCE) {
    // Cron-friendly one-shot: drain the queue and ping the gated sweep, then
    // exit. Gated (not forced) so the Settings time stays authoritative even
    // when driven by an external crontab — point that crontab at a frequent
    // interval (e.g. hourly) and the gate fires the sweep once/day on schedule.
    console.log(`[${ts()}] scheduler (once) → ${BASE}`);
    await drainQueue();
    await pingSweep();
    return;
  }
  console.log(
    `[${ts()}] scheduler → ${BASE} (run-next every ${NEXT_INTERVAL}ms, sweep ping every ${TYPE3_PING_INTERVAL}ms; sweep time set in Settings)`,
  );
  await drainQueue();
  await pingSweep();
  setInterval(drainQueue, NEXT_INTERVAL);
  setInterval(pingSweep, TYPE3_PING_INTERVAL);
}

main();
