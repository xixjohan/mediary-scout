#!/usr/bin/env node
// Test the user's hypothesis "garbled offline-task name ⇒ safe to permanently
// dead-link". Targets OLD anime (where torrent file names are often legacy
// Shift-JIS/GBK → mojibake in 115), transfers each magnet, and captures the
// offline-task `name` field + whether it 秒传'd. If we find a GARBLED name that
// still 秒传s, "garbled = dead" is disproven (garbled is just a display/encoding
// artifact, orthogonal to the content cache). TEST ROOT only; cleans up.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function loadDotEnv(p) { let raw; try { raw = readFileSync(p, "utf8"); } catch { return; }
  for (const line of raw.split("\n")) { const t = line.trim(); if (!t || t.startsWith("#")) continue; const eq = t.indexOf("="); if (eq === -1) continue; const k = t.slice(0, eq).trim(); let v = t.slice(eq + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (process.env[k] === undefined) process.env[k] = v; } }
loadDotEnv(path.join(repoRoot, ".env"));

const { createPanSouResourceProviderFromEnv, createProtectedPan115CookieStorageExecutorFromEnv, Pan115CookieClient } =
  await import(path.join(repoRoot, "packages/workflow/dist/index.js"));
const testRoot = process.env.MEDIA_TRACK_115_TEST_ROOT_CID;
const provider = createPanSouResourceProviderFromEnv();
const storage = createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });
const client = new Pan115CookieClient({ cookie: process.env.PAN115_COOKIE });

const TITLES = ["新世纪福音战士 EVA", "攻壳机动队 1995", "凉宫春日的忧郁", "Cowboy Bebop 星际牛仔", "蒹葭汉化 raw"];
const infoHashOf = (u) => (u.match(/btih:([0-9a-fA-F]{40})/) ?? [])[1]?.toLowerCase() ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// crude mojibake/garble flag: replacement char, or a high share of chars that are
// neither ASCII, CJK, kana, nor common CJK punctuation.
function garbleScore(s) {
  if (!s) return { garbled: false, ratio: 0 };
  let weird = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    const ok =
      c === 0xfffd ? false :
      (c >= 0x20 && c < 0x7f) ||                        // ASCII printable
      (c >= 0x3040 && c <= 0x30ff) ||                   // Japanese kana
      (c >= 0x4e00 && c <= 0x9fff) ||                   // CJK unified
      (c >= 0xff00 && c <= 0xffef) ||                   // fullwidth forms
      "　、。·【】《》「」（）·-_.[]() ".includes(ch);
    if (!ok || c === 0xfffd) weird += 1;
  }
  const ratio = weird / [...s].length;
  return { garbled: s.includes("�") || ratio > 0.35, ratio };
}

const seen = new Set(); const magnets = [];
for (const kw of TITLES) {
  if (magnets.length >= 12) break;
  let snap; try { snap = await provider.search({ keyword: kw, workflowRunId: "nameprobe" }); } catch { continue; }
  let n = 0;
  for (const c of snap.candidates) {
    const url = String(c.providerPayload?.url ?? ""); const h = infoHashOf(url);
    if (!h || seen.has(h)) continue; seen.add(h); magnets.push({ kw, url, h }); n += 1;
    if (n >= 3 || magnets.length >= 12) break;
  }
  console.log(`search "${kw}": +${n}`);
}
console.log(`\nprobing ${magnets.length} old-anime magnets for offline-task NAME + 秒传\n${"=".repeat(74)}`);

let garbledAndAlive = 0;
for (const m of magnets) {
  const dir = await storage.createDirectory({ name: `nameprobe-${Date.now()}-${m.h.slice(0, 6)}`, parentId: testRoot });
  const add = await client.addOfflineTask({ url: m.url, directoryId: dir });
  let name = "", statusText = "", landed = false;
  if (add.ok && !add.alreadyTransferred) {
    for (let i = 0; i < 5; i += 1) {
      await sleep(1800);
      try { const tree = await storage.listTree({ directoryId: dir }); if (tree.some((f) => /\.(mkv|mp4|avi)$/i.test(f.path))) landed = true; } catch {}
      try { const tasks = await client.listOfflineTasks({ page: 1 }); const t = tasks.find((x) => x.infoHash?.toLowerCase() === m.h); if (t) { name = t.name; statusText = t.statusText; } } catch {}
      if (landed && name) break;
    }
  }
  const g = garbleScore(name);
  const alive = landed || /成功|完成/.test(statusText);
  if (g.garbled && alive) garbledAndAlive += 1;
  console.log(`${alive ? "✅秒传" : add.alreadyTransferred ? "↻已存在" : "💀没秒传"} ${g.garbled ? "🔣乱码名" : "🔤正常名"}(weird ${(g.ratio * 100).toFixed(0)}%) "${name}"  [${m.kw}]`);
  if (!add.alreadyTransferred) { try { await client.removeOfflineTask({ infoHashes: [m.h] }); } catch {} }
  try { await storage.removeDirectory(dir); } catch {}
}
console.log(`\n${"=".repeat(74)}\n>>> 乱码名 AND 秒传(活)的磁力数量 = ${garbledAndAlive}`);
console.log(garbledAndAlive > 0
  ? "→ 证实:乱码名 ≠ 死链(乱码只是显示/编码问题,这些资源照样秒传)。不可硬记录。"
  : "→ 本批没撞到「乱码名却秒传」的(可能样本太少或这些源名字都正常);理论上仍可能存在。");
