// Quark acquisition e2e: drives the REAL QuarkStorageExecutor against a live
// quark drive (cookie at /tmp/quark-cookie.txt, NEVER committed). Proves the full
// 转存 chain + fail-loud + magnet-refusal + auth freeze + move/rename, end to end.
//   npx tsx scripts/quark-acquire-e2e.mts
//
// Lands into a fresh staging dir UNDER the designated test folder
// (media-track-test, fid 9c7a165441ac4d67b53b540a141b7d0d), then recycles it.
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
for (const line of readFileSync(path.join(repoRoot, ".env"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[k] ??= v;
}

const wf = await import("@media-track/workflow");
const { QuarkCookieClient, QuarkStorageExecutor, isQuarkAuthError } = wf;
type ResourceCandidate = import("@media-track/workflow").ResourceCandidate;

const cookie = readFileSync("/tmp/quark-cookie.txt", "utf8").trim();
const TEST_ROOT = "9c7a165441ac4d67b53b540a141b7d0d"; // media-track-test
const PANSOU = process.env.PANSOU_BASE_URL;
if (!PANSOU) throw new Error("PANSOU_BASE_URL not set in .env");

let failed = 0;
const ok = (n: string, c: boolean) => {
  console.log(`${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) failed++;
};

function shareCandidate(url: string, password: string): ResourceCandidate {
  return {
    id: `cand_${Math.random().toString(36).slice(2, 8)}`,
    snapshotId: "snap_e2e",
    index: 0,
    title: "quark e2e",
    type: "manual",
    source: "pansou",
    episodeHints: [],
    qualityHints: [],
    providerPayload: { url, password },
  };
}

// A fresh executor whose write scope is the test root (so we may create staging
// dirs under it and recycle them).
const client = new QuarkCookieClient({ cookie });
const exec = new QuarkStorageExecutor({
  client,
  writeScopeDirectoryIds: [TEST_ROOT],
  minVideoSizeBytes: 1,
});

// --- 1) PanSou → quark links ---
const psRes = await fetch(`${PANSOU}/api/search`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "User-Agent": "clawd/1.0" },
  body: JSON.stringify({ kw: "肖申克的救赎", res: "all" }),
});
const ps = (await psRes.json()) as { data?: { results?: Array<{ title?: string; links?: Array<{ type?: string; url?: string; password?: string }> }> } };
const quarkLinks: Array<{ url: string; password: string }> = [];
for (const r of ps.data?.results ?? []) {
  for (const l of r.links ?? []) {
    if ((l.type === "quark" || String(l.url).includes("pan.quark.cn/s/")) && l.url) {
      quarkLinks.push({ url: l.url, password: l.password ?? "" });
    }
  }
}
ok(`PanSou returned quark links (${quarkLinks.length})`, quarkLinks.length > 0);

// --- 2) transfer a real share into a fresh staging dir ---
const staging = await exec.createDirectory({ name: `e2e-${Date.now()}`, parentId: TEST_ROOT });
console.log("staging dir:", staging);

let transferred = false;
let landedFileId = "";
let landedName = "";
for (const link of quarkLinks.slice(0, 8)) {
  const attempt = await exec.transfer({ workflowRunId: "e2e_run", directoryId: staging, candidate: shareCandidate(link.url, link.password) });
  console.log(`  transfer ${link.url} → ${attempt.status} (${attempt.providerMessage.slice(0, 60)})`);
  if (attempt.status === "succeeded") {
    transferred = true;
    landedFileId = attempt.materializedFileIds[0] ?? "";
    break;
  }
}
ok("transfer succeeded (real 转存 into quark)", transferred);

if (transferred) {
  const videos = await exec.listVideoFiles(staging);
  ok("listVideoFiles sees the transferred video", videos.length > 0);
  const landed = videos.find((v) => v.id === landedFileId) ?? videos[0]!;
  landedName = landed.name;
  console.log("  landed:", landed.name, `${(landed.sizeBytes / 1e9).toFixed(2)}GB`);

  // --- 3) rename real verification ---
  const newName = `renamed-${Date.now()}.mkv`;
  await exec.renameFile({ directoryId: staging, fileId: landed.providerFileId, newName });
  const afterRename = await exec.listVideoFiles(staging);
  ok("renameFile took effect (real API)", afterRename.some((v) => v.name === newName));

  // --- 4) move real verification (into a second in-scope staging dir) ---
  const staging2 = await exec.createDirectory({ name: `e2e2-${Date.now()}`, parentId: TEST_ROOT });
  const moved = await exec.moveFiles({ fileIds: [landed.providerFileId], targetDirectoryId: staging2 });
  ok("moveFiles moved the file (real API)", moved.moved.includes(landed.providerFileId));
  // The move task completes, but the destination's file-list index can lag a beat
  // — poll it (condition-based) rather than assume a single immediate read.
  let inStaging2 = false;
  for (let i = 0; i < 6 && !inStaging2; i++) {
    const dest = await exec.listVideoFiles(staging2);
    inStaging2 = dest.some((v) => v.providerFileId === landed.providerFileId);
    if (!inStaging2) await new Promise((r) => setTimeout(r, 700));
  }
  ok("moved file now lives in the destination dir", inStaging2);
  // cleanup staging2 (recycle)
  await exec.removeDirectory(staging2);
}

// --- 5) fail-loud on a dead share (status failed, never silent success) ---
const deadAttempt = await exec.transfer({
  workflowRunId: "e2e_run",
  directoryId: staging,
  candidate: shareCandidate("https://pan.quark.cn/s/0000deadbeef", ""),
});
ok("dead share → transfer status failed (fail-loud)", deadAttempt.status === "failed" && deadAttempt.providerMessage.length > 0);

// --- 6) magnet candidate → throws QUARK_NO_MAGNET ---
let magnetThrew = false;
try {
  const magnet = { ...shareCandidate("magnet:?xt=urn:btih:deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", ""), type: "magnet" as const };
  await exec.transfer({ workflowRunId: "e2e_run", directoryId: staging, candidate: magnet });
} catch (error) {
  magnetThrew = error instanceof Error && error.message.includes("QUARK_NO_MAGNET");
}
ok("magnet candidate → throws QUARK_NO_MAGNET", magnetThrew);

// --- 7) bad cookie → QuarkAuthError (freeze signal) ---
let authClassified = false;
try {
  await new QuarkCookieClient({ cookie: "__uid=dead; __kps=dead" }).listItems({ directoryId: TEST_ROOT });
} catch (error) {
  authClassified = isQuarkAuthError(error);
  console.log("  dead cookie threw:", (error as Error).message.slice(0, 80));
}
ok("dead cookie → isQuarkAuthError true (drive would freeze)", authClassified);

// --- cleanup: recycle the staging dir ---
await exec.removeDirectory(staging);
console.log(`\nrecycled staging dir ${staging}`);

console.log(failed ? `\n${failed} CHECK(S) FAILED` : `\nQUARK ACQUIRE E2E PASSED — 转存(${landedName})/rename/move/fail-loud/magnet拒/鉴权冻结 全通`);
process.exit(failed ? 1 : 0);
