#!/usr/bin/env node
// §7 real TWO-PHYSICAL-DRIVE multi-account e2e. Requires a 2nd real 115 cookie
// at /tmp/friend-115-cookie.txt (NEVER committed). Proves: a 2nd app-account can
// bind a DIFFERENT physical 115 (its own provisioned dirs), coexisting with the
// default account's 115 under instance-wide uniqueness.
//   node scripts/two-drive-e2e.mjs setup     # provision + bind friend's 115 + isolation
//   node scripts/two-drive-e2e.mjs cleanup   # remove friend account/conn (+ drive dirs)
import { readFileSync } from "node:fs";
import {
  createSqliteWorkflowRepository,
  createProtectedPan115CookieStorageExecutorFromEnv, provisionCategoryDirs, resolveStorageBinding,
} from "@media-track/workflow";
import { loadDotEnv, appDbPath, openAppDb } from "./_lib/sqlite-db.mjs";

loadDotEnv();
const mode = process.argv[2] === "cleanup" ? "cleanup" : "setup";
const friendCookie = readFileSync("/tmp/friend-115-cookie.txt", "utf8").trim();
const FRIEND_ACCT = "acct_friend_e2e", FRIEND_UID = "100000002";
// Pure-SQLite single engine (task S1.4b): the app's own DB file; the repository
// constructor creates the schema on first open (no separate initialize step).
const repo = createSqliteWorkflowRepository({ path: appDbPath() });
// Friend's drive is fresh/empty; scope writes to its root for provisioning (the
// top media-track/ folder must be created under root). Real multi-drive would
// scope each drive to its own provisioned root after creation.
const exec = createProtectedPan115CookieStorageExecutorFromEnv({ env: { ...process.env, PAN115_COOKIE: friendCookie, MEDIA_TRACK_115_WRITE_SCOPE_CIDS: "0" } });
let failed = 0; const ok = (n, c) => { console.log(`${c ? "ok  " : "FAIL"} ${n}`); if (!c) failed++; };

// Raw row cleanup (the repository API has no delete-account/connection surface).
function dropFriendRows() {
  const db = openAppDb();
  try {
    db.prepare("DELETE FROM connected_storages WHERE account_id = ? OR provider_uid = ?").run(FRIEND_ACCT, FRIEND_UID);
    db.prepare("DELETE FROM accounts WHERE id = ?").run(FRIEND_ACCT);
  } finally {
    db.close();
  }
}

if (mode === "cleanup") {
  const cs = await repo.findConnectedStorageByUid("pan115", FRIEND_UID);
  if (cs?.rootCid) { try { await exec.deleteItems({ fileIds: [cs.rootCid] }); console.log("deleted media-track tree from friend's 115"); } catch (e) { console.log("dir delete skipped:", e.message); } }
  dropFriendRows();
  await repo.close?.();
  console.log("friend account + connection removed"); process.exit(0);
}

try {
  dropFriendRows();

  // provision dirs in the FRIEND's real 115 (root '0') — its own endpoint, not env CIDs
  const cids = await provisionCategoryDirs({
    baseParentId: "0",
    storage: {
      listChildDirs: (parentId) => exec.listChildDirectories(parentId),
      createDirectory: (d) => exec.createDirectory(d),
    },
  });
  console.log("provisioned in friend's 115:", JSON.stringify(cids));
  ok("friend 115 got real category CIDs", !!(cids.rootCid && cids.moviesCid && cids.tvCid && cids.animeCid));

  await repo.createAccount({ id: FRIEND_ACCT, username: "friend_e2e", passwordHash: "", groupId: null, isOwner: false, createdAt: new Date().toISOString() });
  await repo.upsertConnectedStorage({
    id: `cs_${FRIEND_UID}`, accountId: FRIEND_ACCT, provider: "pan115", providerUid: FRIEND_UID,
    payload: { cookie: friendCookie }, rootCid: cids.rootCid, moviesCid: cids.moviesCid, tvCid: cids.tvCid, animeCid: cids.animeCid,
    createdAt: new Date().toISOString(),
  });

  ok("friend owns uid 100000002", (await repo.findConnectedStorageByUid("pan115", FRIEND_UID))?.accountId === FRIEND_ACCT);
  ok("default still owns its own uid 100000001", (await repo.findConnectedStorageByUid("pan115", "100000001"))?.accountId === "acct_default");
  ok("two physical 115s coexist (friend has exactly 1 conn)", (await repo.listConnectedStorages(FRIEND_ACCT)).length === 1);
  const dec = resolveStorageBinding({ provider: "pan115", providerUid: "100000001", accountId: FRIEND_ACCT, existing: await repo.findConnectedStorageByUid("pan115", "100000001") });
  ok("friend binding the DEFAULT's 115 is rejected", dec.action === "reject");

  const rootDirs = (await exec.listChildDirectories("0")).map((d) => d.name);
  console.log("friend 115 root now has:", rootDirs);
  ok("media-track tree visible in friend's 115", rootDirs.includes("media-track"));
} finally {
  await repo.close?.();
}
console.log(failed ? `\n${failed} FAILED` : "\nTWO-DRIVE SETUP (stage A) PASSED");
process.exit(failed ? 1 : 0);
