/**
 * Per-brand transfer / dead-links / black-box manuals — the agent-facing text.
 *
 * This module deliberately has NO imports. `storage-brands.ts` references these
 * constants from each brand entry (so "which manual is mine" is answered in the
 * registry), and skill.ts reads them back out — importing them from skill.ts
 * instead would make that a circular import (skill.ts needs getStorageBrand), and
 * the constants would be `undefined` at registry-evaluation time. Keep this file
 * dependency-free.
 */

export const DEAD_LINKS_BLACK_BOX = `# Dead links, magnets, and black-box resources

> 提醒:raw 候选已预搜好,先 viewResourceSnapshot() 通读活期文档再动手;searchResources 只用于繁体/英文升级,别拿画质/字幕词搜。

## What "landed" means
transferCandidate returns the TRUE materialized files (the system rereads for you). Trust THAT, not your prediction.
- A 115 share that transfers without error has landed.
- A 115 share fails LOUD with a clear reason — the real ones you will see: "链接已过期" (expired), "分享已取消" (cancelled), "访问码错误" (wrong access code), "错误的链接" (bad/malformed link). All = dead. Switch to another covering candidate — a dead link is the NORM, never a reason to give up; try the next resource that covers the need. (For a movie, transferUntilLanded over your ranked 115 shares burns through these dead ones automatically.)
- A magnet can SILENTLY fail: no error, yet nothing materializes. Trust the staging reread — if nothing landed, it is dead; move on to a 秒传-able candidate instead of waiting (the account's value is instant transfer, not a slow download).
- **SYSTEMIC BLOCK** (别甩锅): when a transfer fails with "云下载配额不足" / "登录超时" / "请升级VIP" / "鉴权失败" — the resource EXISTS but the ACCOUNT is blocked (quota / auth / VIP). The tool result carries \`systemicBlock: { reason: "..." }\`. **立即停 — DO NOT keep transferring.** Every candidate will fail the same way. Report honestly: the resource was found, the account cannot transfer it (not "no resource"). This is actionable (top up quota / re-login), never blame the resource.

## Black-box gate (this is exactly where the 奥本海默 run failed)
"Transparent" = the title states size / resolution / episodes / release group (e.g. "The.Dark.Knight.2008.2160p.BluRay.FGT 16.68GB"). "Black-box / opaque" = a bare name ("名称: 奥本海默") or a vague bundle ("【变形金刚系列】1~5部").
- If a TRANSPARENT candidate clearly covers the need, select ONLY it and STOP. Do NOT also transfer opaque ones "just in case".
- ONLY when ZERO transparent candidate covers the need may you fall back to a black-box one. When you do, your VERY NEXT step after it lands MUST be inspectStaging to VERIFY it actually holds the target (the right film / the missing episodes) — black-box coverage is UNPROVEN until you read the real files.
  - Verified to cover → process it (move / dedup / mark) and finish. Do NOT keep searching for a "better" one.
  - Does not cover → treat it as a dead candidate, clean its staging residue with deleteFiles, try the next.
- For an ongoing show's just-aired episode, a black-box resource whose publish time predates that episode's air time almost certainly does NOT contain it — do not bet on it.`;

export const DEAD_LINKS_BLACK_BOX_QUARK = `# Dead links, 转存, and black-box resources (夸克网盘)

> 提醒:raw 候选已预搜好,先 viewResourceSnapshot() 通读活期文档再动手;searchResources 只用于繁体/英文升级,别拿画质/字幕词搜。

## How transfer works on THIS drive (夸克)
The drive is 夸克网盘. Every candidate is a 夸克分享链 (pan.quark.cn/s/<id>) — a 转存分享 (the 115-秒传 equivalent): the system exchanges the share token, lists the share, and saves its files into staging. transferCandidate returns the TRUE materialized files (the system rereads for you). Trust THAT, not your prediction.

## 无磁力 (this is the key difference from 115)
夸克 has NO magnet / offline-download web API. So there are NO magnet candidates here (the resource provider only surfaces 夸克分享链), and a magnet would fail LOUD ("QUARK_NO_MAGNET") if ever forced. There is therefore NO "magnet silently fails / wait for download" nuance at all — every candidate is an instant 转存分享 that either lands or fails loud.

## Fail-loud (a dead / expired / wrong share)
A 夸克分享 fails LOUD with a clear reason — switch to another covering candidate:
- "分享不存在" (code 41006), "分享已取消 / 已失效 / 已过期", "提取码错误 / 需要提取码". All = dead.
A dead link is the NORM, never a reason to give up — try the next 夸克分享 that covers the need. For a movie, transferUntilLanded over your ranked 夸克分享 burns through the dead ones automatically (it relies on this loud failure, exactly like the 115 path).

## SYSTEMIC BLOCK (别甩锅)
When a 夸克转存 fails with a SYSTEMIC message — "配额不足" / "额度已用完" / "VIP会员" / "登录" / "鉴权" — the resource EXISTS but the ACCOUNT is blocked (quota / auth / VIP). The tool result carries \`systemicBlock: { reason: "..." }\`. **立即停 — DO NOT keep transferring.** Every candidate will fail the same way. Report honestly: the resource was found, the account cannot transfer it (not "no resource"). This is actionable (top up / re-login), never blame the resource.

## Black-box gate (same discipline as 115)
"Transparent" = the title states size / resolution / episodes / release group. "Black-box / opaque" = a bare name or a vague bundle.
- If a TRANSPARENT 夸克分享 clearly covers the need, select ONLY it and STOP. Do NOT also transfer opaque ones "just in case".
- ONLY when ZERO transparent candidate covers may you fall back to a black-box one. When you do, your VERY NEXT step after it lands MUST be inspectStaging to VERIFY it actually holds the target — black-box coverage is UNPROVEN until you read the real files.
  - Verified to cover → process it (move / dedup / mark) and finish. Do NOT keep searching for a "better" one.
  - Does not cover → treat it as a dead candidate, clean its staging residue with deleteFiles, try the next.`;

export const DEAD_LINKS_BLACK_BOX_UC = `# Dead links, 转存, and black-box resources (UC网盘)

> 提醒:raw 候选已预搜好,先 viewResourceSnapshot() 通读活期文档再动手;searchResources 只用于繁体/英文升级,别拿画质/字幕词搜。

## How transfer works on THIS drive (UC)
The drive is UC网盘 (drive.uc.cn). Every candidate is a UC分享链 (drive.uc.cn/s/<id>) — a 转存分享 (the 115-秒传 equivalent): the system exchanges the share token, lists the share, and saves its files into staging. This is the SAME protocol as 夸克. transferCandidate returns the TRUE materialized files (the system rereads for you). Trust THAT, not your prediction.

## 无磁力 (this is the key difference from 115)
UC has NO usable magnet / offline-download web API (its offline endpoint is gated behind a runtime-encrypted client payload). So there are NO magnet candidates here (the resource provider only surfaces UC分享链), and a magnet would fail LOUD ("UC_NO_MAGNET") if ever forced. There is therefore NO "magnet silently fails / wait for download" nuance at all — every candidate is an instant 转存分享 that either lands or fails loud.

## 死链很多,这是常态 (important)
UC shares on aggregators expire FAST — roughly HALF are already dead by the time you see them. Do NOT read a run of dead links as "this work has no resources". Every dead share is cheap to reject; keep walking the ranked list. A short bench of UC分享 for a popular title is NORMAL.

## Fail-loud (a dead / expired / wrong share)
A UC分享 fails LOUD with a clear reason — switch to another covering candidate:
- "分享地址已失效" (code 41011), "好友已取消了分享" (code 41012), "分享不存在" (code 41027), "提取码错误 / 需要提取码". All = dead.
A dead link is the NORM, never a reason to give up — try the next UC分享 that covers the need. For a movie, transferUntilLanded over your ranked UC分享 burns through the dead ones automatically (it relies on this loud failure, exactly like the 115 path).

## SYSTEMIC BLOCK (别甩锅)
When a UC转存 fails with a SYSTEMIC message — "配额不足" / "额度已用完" / "VIP会员" / "登录" / "鉴权" — the resource EXISTS but the ACCOUNT is blocked (quota / auth / VIP). The tool result carries \`systemicBlock: { reason: "..." }\`. **立即停 — DO NOT keep transferring.** Every candidate will fail the same way. Report honestly: the resource was found, the account cannot transfer it (not "no resource"). This is actionable (top up / re-login), never blame the resource.

Separately, drive.uc.cn sometimes shows an account-risk banner ("账号涉嫌违规") in its own UI while transfers still succeed. Do NOT read that banner as a reason to stop, and do not put it in your report as a transfer failure — judge only by what transferCandidate actually returned.

## Black-box gate (same discipline as 115)
"Transparent" = the title states size / resolution / episodes / release group. "Black-box / opaque" = a bare name or a vague bundle.
- If a TRANSPARENT UC分享 clearly covers the need, select ONLY it and STOP. Do NOT also transfer opaque ones "just in case".
- ONLY when ZERO transparent candidate covers may you fall back to a black-box one. When you do, your VERY NEXT step after it lands MUST be inspectStaging to VERIFY it actually holds the target — black-box coverage is UNPROVEN until you read the real files.
  - Verified to cover → process it (move / dedup / mark) and finish. Do NOT keep searching for a "better" one.
  - Does not cover → treat it as a dead candidate, clean its staging residue with deleteFiles, try the next.`;

export const DEAD_LINKS_BLACK_BOX_TIANYI = `# Dead links, 转存, and black-box resources (天翼云盘)

> 提醒:raw 候选已预搜好,先 viewResourceSnapshot() 通读活期文档再动手;searchResources 只用于繁体/英文升级,别拿画质/字幕词搜。

## How transfer works on THIS drive (天翼)
The drive is 天翼云盘. Every candidate is a 天翼分享链 (cloud.189.cn/t/<code>) — a 转存分享 (the 115-秒传 equivalent): the system SHARE_SAVE's the share (getShareInfo → listShareDir → createBatchTask{type:SHARE_SAVE} → checkBatchTask 轮询) and saves its files into staging. transferCandidate returns the TRUE materialized files (the system rereads for you). Trust THAT, not your prediction.

## 无磁力 (this is the key difference from 115)
天翼 has NO magnet / offline-download web API. So there are NO magnet candidates here (the resource provider only surfaces 天翼分享链), and a magnet would fail LOUD ("TIANYI_NO_MAGNET") if ever forced. There is therefore NO "magnet silently fails / wait for download" nuance at all — every candidate is an instant 转存分享 that either lands or fails loud.

## Fail-loud (a dead / expired / access-code share)
A 天翼分享 fails LOUD with a clear reason — switch to another covering candidate:
- "分享不存在" / "ShareNotFound", "分享已失效 / 已过期", "需要提取码 / 提取码错误". All = dead (or un-openable without a code you don't have).
A dead link is the NORM, never a reason to give up — try the next 天翼分享 that covers the need. For a movie, transferUntilLanded over your ranked 天翼分享 burns through the dead ones automatically (it relies on this loud failure, exactly like the 115 path).

## SYSTEMIC BLOCK (别甩锅)
When a 天翼转存 fails with a SYSTEMIC message — "配额不足" / "额度已用完" / "VIP会员" / "登录" / "鉴权" — the resource EXISTS but the ACCOUNT is blocked (quota / auth / VIP). The tool result carries \`systemicBlock: { reason: "..." }\`. **立即停 — DO NOT keep transferring.** Every candidate will fail the same way. Report honestly: the resource was found, the account cannot transfer it (not "no resource"). This is actionable (top up / re-login), never blame the resource.

## Black-box gate (same discipline as 115)
"Transparent" = the title states size / resolution / episodes / release group. "Black-box / opaque" = a bare name or a vague bundle.
- If a TRANSPARENT 天翼分享 clearly covers the need, select ONLY it and STOP. Do NOT also transfer opaque ones "just in case".
- ONLY when ZERO transparent candidate covers may you fall back to a black-box one. When you do, your VERY NEXT step after it lands MUST be inspectStaging to VERIFY it actually holds the target — black-box coverage is UNPROVEN until you read the real files.
  - Verified to cover → process it (move / dedup / mark) and finish. Do NOT keep searching for a "better" one.
  - Does not cover → treat it as a dead candidate, clean its staging residue with deleteFiles, try the next.`;

export const DEAD_LINKS_BLACK_BOX_PAN123 = `# Dead links, 转存, 离线磁力, and black-box resources (123网盘)

> 提醒:raw 候选已预搜好,先 viewResourceSnapshot() 通读活期文档再动手;searchResources 只用于繁体/英文升级,别拿画质/字幕词搜。

## How transfer works on THIS drive (123) — DUAL path (like 115)
The drive is 123网盘. Candidates may be either:
1. **123 分享链** (123pan.com/s/<key> — 123684/123865/123912 等镜像域也是真的;提取码在 pwd): 转存分享 / 秒传复制 into staging via server-side async copy; bounded settle-polling is built in — you do NOT poll yourself.
2. **磁力 / ed2k**: native offline download (resolve → submit → poll until status succeed). The system waits for the offline task; you still trust the staging reread, not your prediction.

transferCandidate returns the TRUE materialized files. Prefer a transparent 123 分享 when both cover the need (instant copy); use magnet when share coverage is thin. For TV/anime or any magnet/ed2k candidate, use transferCandidate and then inspectStaging; transferUntilLanded is movie-only and accepts share links only.

For a movie with ranked 123 share links, use transferUntilLanded to burn through dead shares automatically. Do not give up after one dead link.

## Fail-loud — shares
A 123 分享 fails LOUD — switch candidate:
- "分享为空 / 已失效", "分享不存在", "分享已取消 / 链接失效 / 已过期", "提取码错误 / 需要提取码".

## Fail-loud — magnets / offline
A dead magnet fails LOUD with PAN123_OFFLINE_RESOLVE_FAILED / PAN123_OFFLINE_FAILED — switch to the next covering 磁力 or 123 分享. If the bounded offline poll expires, the result is no_target_change (the task is cancelled before moving on); inspectStaging once, then switch only if still empty. Dead magnets are the NORM, never a reason to give up.

## no_target_change (third outcome on the SHARE path — NOT a loud failure)
On a large 秒传复制, the settle window can expire before files appear. Do NOT immediately re-transfer the same candidate (double-land risk): inspectStaging first; only when still empty switch candidate. For a magnet, no_target_change means the offline task was cancelled after the bounded poll without a confirmed landing (slow torrent or task that finished without producing a video) — the same action applies: inspectStaging once, then switch if still empty.

## SYSTEMIC BLOCK (别甩锅)
When a 123 transfer fails with a SYSTEMIC message — "配额不足" / "额度已用完" / "容量不足" / "离线下载配额不足" / "VIP会员" / "登录" / "鉴权" / PAN123_OFFLINE_CLEANUP_FAILED — the resource EXISTS but the ACCOUNT or task cleanup is blocked. The tool result carries \`systemicBlock: { reason: "..." }\`. **立即停 — DO NOT keep transferring.** Report honestly: resource found, account cannot transfer or cancellation is unconfirmed (not "no resource").

## Black-box gate (same discipline as 115)
"Transparent" = the title states size / resolution / episodes / release group. "Black-box / opaque" = a bare name or a vague bundle.
- If a TRANSPARENT 123 分享 or magnet clearly covers the need, select ONLY it and STOP.
- ONLY when ZERO transparent candidate covers may you fall back to a black-box one; next step MUST be inspectStaging.
  - Verified → process and finish.
  - Does not cover → deleteFiles residue, try the next.
- For an ongoing show's just-aired episode, a black-box resource whose publish time predates that episode's air time almost certainly does NOT contain it — do not bet on it.`;

export const DEAD_LINKS_BLACK_BOX_GUANGYA = `# Dead links, offline tasks, and black-box resources (光鸭云盘)

> 提醒:raw 候选已预搜好,先 viewResourceSnapshot() 通读活期文档再动手;searchResources 只用于繁体/英文升级,别拿画质/字幕词搜。

## How transfer works on THIS drive (光鸭) — two paths
1. **光鸭分享链** (guangyapan.com/s/<id>): transferCandidate does a server-side 转存 (restore_share) of the whole share root into staging — folders land whole, in seconds, no seeding. Then the system rereads staging and returns the TRUE materialized files. Trust THAT, not your prediction.
2. **磁力 / ed2k / BT**: transferCandidate runs resolve_res → create_task → polls the offline task until it lands, then rereads staging the same way.

When a transparent 光鸭分享 covers the need, prefer it over a magnet (instant and certain once it lands). Another brand's share link (夸克/115/123/天翼) CANNOT land on 光鸭 — it fails loud with "GUANGYA_UNSUPPORTED_LINK"; skip it.

## Dead shares fail LOUD (move on at once)
A 光鸭分享 is unusable more often than not. These are PROVEN dead and come back as a failed attempt — switch to the next covering candidate at once:
- 分享已失效 / 分享链接错误 / 参数错误 — dead, cancelled or malformed link.
- GUANGYA_SHARE_EMPTY — the share OPENS but lists no files. About half of the 光鸭分享 on PanSou look like this (the sharer restricted it, or the content is under review). It is NOT "the share is empty but maybe fine" — treat it as dead.
- GUANGYA_RESTORE_FAILED — the 转存 task reported failure.
- GUANGYA_SHARE_NO_VIDEO — the 转存 finished but brought no video (the share holds only zips / images); not the film.
Because these fail loud, a movie can hand a ranked list of same-film 光鸭分享 to transferUntilLanded.

## A slow 转存 is PENDING, not dead
GUANGYA_RESTORE_TIMEOUT / GUANGYA_RESTORE_PENDING come back as no_target_change: the 转存 was accepted and may still be RUNNING (the window ended, or polling it hit a network error), so it may still land. transferUntilLanded STOPS there on purpose. Do NOT immediately transfer another candidate (that is how a film lands twice) — inspectStaging first; if it has landed, continue from there; only if nothing arrived after a re-read, move on.

## Dead magnets fail QUIETLY (trust the reread)
A magnet can be dead: resolve_res returns nothing, or the offline task never materializes (no seeds / removed). When nothing lands, treat the magnet as dead and switch to the NEXT covering candidate. A dead link is the NORM, never a reason to give up.

## SYSTEMIC BLOCK (别甩锅)
When a 光鸭 transfer fails with a SYSTEMIC message — "配额不足" / "额度已用完" / "VIP会员" / "登录" / "鉴权" / 离线下载被限 — the resource EXISTS but the ACCOUNT is blocked (quota / auth / VIP). The tool result carries \`systemicBlock: { reason: "..." }\`. **立即停 — DO NOT keep transferring.** Every candidate will fail the same way. Report honestly: the resource was found, the account cannot transfer it (not "no resource"). This is actionable (top up / re-login), never blame the resource.

## Black-box gate (same discipline as 115)
"Transparent" = the title states size / resolution / episodes / release group. "Black-box / opaque" = a bare name or a vague bundle.
- If a TRANSPARENT magnet clearly covers the need, select ONLY it and STOP. Do NOT also transfer opaque ones "just in case".
- ONLY when ZERO transparent candidate covers may you fall back to a black-box one. When you do, your VERY NEXT step after it lands MUST be inspectStaging to VERIFY it actually holds the target — black-box coverage is UNPROVEN until you read the real files.
  - Verified to cover → process it (move / dedup / mark) and finish. Do NOT keep searching for a "better" one.
  - Does not cover → treat it as a dead candidate, clean its staging residue with deleteFiles, try the next.
- For an ongoing show's just-aired episode, a black-box resource whose publish time predates that episode's air time almost certainly does NOT contain it — do not bet on it.`;
