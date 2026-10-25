#!/usr/bin/env node
// One live notification through the REAL pipeline (sendPushNotifications →
// dispatchNotifications → buildNotifyMessage → channels), using a real tracked
// title's poster + the user's configured Server酱 sendkey (read from the DB).
// Proves the new L2 format renders for real. Sends ONE message; no DB writes.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadDotEnv, appDbPath } from "./_lib/sqlite-db.mjs";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv();

const { createSqliteWorkflowRepository, buildMovieReport, formatReportPushText, buildNotifyMessage, sendPushNotifications } =
  await import(path.join(repoRoot, "packages/workflow/dist/index.js"));
const repo = createSqliteWorkflowRepository({ path: appDbPath() });

// 热辣滚烫 — real tracked movie, real TMDB poster.
const report = buildMovieReport("热辣滚烫", "2160p", {
  posterPath: "/fI5BIp48yERyYhu7O6XlDT4puSZ.jpg",
  tmdbId: 1229349,
  mediaType: "movie",
  year: 2024,
});
const notification = {
  id: `notiftest_${Date.now()}`,
  workflowRunId: "notiftest",
  kind: "movie_init",
  title: report.titleName,
  body: formatReportPushText(report),
  createdAt: new Date().toISOString(),
  trigger: "user",
  report,
};

console.log("--- the Server酱 desp that will be sent ---\n" + buildNotifyMessage(report).markdown + "\n");
const sentTo = await sendPushNotifications({ repository: repo, notification });
console.log("sent to channels:", sentTo.length ? sentTo.join(", ") : "(none configured — check push_serverchan in app_settings)");
process.exit(0);
