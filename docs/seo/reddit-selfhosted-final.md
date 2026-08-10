# r/selfhosted 发帖 — 最终可直接粘贴版

**发帖方式**：用 Reddit 的 **Images** tab（不是 Text tab），先上传 3 张图并填 caption，正文粘贴下面的 Body。

---

## ① TITLE（复制这一行）

```
Mediary Scout: an LLM agent that finds media, transfers it into your cloud drive, then verifies what actually landed (self-hosted, 0BSD)
```

136 / 300 字符。

---

## ② FLAIR

`Wednesday`（若当天是周三）；否则选与自托管应用相关的常规 flair。
本项目是自托管应用**本身**，不属于「管理工具」类，无需等周三 —— 版规原文：*"if the core topic is a self-hosted app/tool, it's allowed"*。

---

## ③ 三张图 + CAPTION（按此顺序上传）

### 图 1：`docs/images/demo.gif`（2.3 MB）

Caption（复制）：
```
Search → hit 获取 ("acquire") → the agent searches, picks a candidate, transfers it server-side into the drive, then re-reads the drive to verify. No local download.
```

### 图 2：`docs/images/library.png`（3.0 MB）

Caption（复制）：
```
Library view. Badges: green = complete, orange = incomplete, blue = scheduled/unreleased. The "6/9/9" counters are obtained/aired/total episodes — it tracks per-episode, not per-show. (UI is Chinese-only for now — see limitations in the post.)
```

### 图 3：`docs/images/notifications.png`（0.1 MB）

Caption（复制）：
```
The part I actually care about: honest reporting. Top two landed (9.5 GB / 35.8 GB — server-side copies, so zero local bandwidth). Third says "got 3/5 episodes, 2 missing" and names them (S01E04–S01E05). Bottom says "found nothing suitable this sweep, will retry tomorrow" instead of silently doing nothing.
```

---

## ④ BODY（复制以下全部）

**Repo:** https://github.com/fancydirty/mediary-scout
**Live demo (read-only):** https://demo.mediaryscout.app
**License:** 0BSD

### What it does

You ask for a movie, show, or anime. An LLM agent then:

1. **Searches** your indexers for it (Prowlarr, and/or PanSou — a Chinese cloud-drive share search engine)
2. **Reads the release titles and decides** which candidate actually is the thing you asked for — the right season pack, the right episode range, the right language track
3. **Transfers it into your own cloud drive** server-side (no local bandwidth, no local disk)
4. **Reads the drive back** to verify what actually landed, per episode
5. **Reports honestly what's still missing**, and retries on a schedule

The parts I care about most are 2 and 4. It doesn't match a quality profile and hope — it reads the messy real-world release title, decides, then goes back and checks what actually landed. And when it can't find something, it says so (third screenshot) instead of silently doing nothing.

### Why not just use Sonarr/Radarr

I'm not claiming it's better — the *arr stack is mature and I'd still recommend it for a normal torrent + local-disk setup. This is a different shape:

| | *arr stack | Mediary Scout |
|---|---|---|
| Candidate choice | rules / regex / quality profiles | LLM reads the title and reasons |
| Where files land | local disk via download client | server-side copy into a cloud drive |
| Verification | filename matching | agent re-reads the drive, per episode |
| When it fails | retry queue | re-keywords, tries other candidates, then reports which episodes are still missing |

The cloud-drive part is the reason it exists: server-side transfer means a 36 GB REMUX costs you no local bandwidth and no local storage. (Closest Western analogue is a debrid service's cloud-download, if that helps place it.)

### Stack

- Next.js web UI + an in-process agent worker
- Postgres (container) or SQLite (desktop app)
- Docker Compose brings up web + Postgres + a bundled search backend
- Desktop builds for macOS + Windows (signed/notarized on macOS)
- BYO LLM key (any OpenAI-compatible endpoint), BYO drive credentials, BYO TMDB key
- Also exposes a local HTTP API so a coding agent (Claude Code / Codex / etc.) can drive it without opening the GUI

Resource use, measured on my own box: **~200 MB RAM for the whole stack** (web 153 MB, Postgres 24 MB, search backend 22 MB). Add ~20 MB if you enable the optional tunnel for remote access.

### The honest limitations — please read before trying

**1. It currently only supports Chinese cloud drives.** Quark, 115, 123, GuangYaPan, Tianyi. If you're outside China you probably can't get an account on any of these, which means **the "where files land" half of the app is unusable for you today.**

**2. The UI is Chinese-only.** No i18n layer yet — strings are inline.

**3. Prowlarr already works, though.** The magnet/torrent search half is generic. So the architecture isn't China-specific — it's that the last mile (the storage executor that actually puts the file somewhere) has only been implemented for Chinese drives, because that's what I use.

I'd rather say this plainly than have you deploy it and discover it 20 minutes in.

### Where help would actually matter

Both extension points are small, deliberately:

- **A new storage backend** is a registry entry (9 fields: auth kind, error classification, which resource types it can consume, etc.) plus a drive client and a "storage executor" for that drive's transfer API. The interface is in `packages/workflow/src/storage-brands.ts`. An rclone-backed executor, a debrid service, or plain local-disk would immediately make this useful outside China.
- **A new resource provider** is a one-method interface — `search(keyword) → candidates`. PanSou and Prowlarr both implement it.
- **i18n** — currently zero infrastructure, so it's a real chunk of work, but a mechanical one.

0BSD license, so fork it and do whatever you want, no attribution needed.

### AI involvement — being upfront

This project was built across many iterated AI coding sessions. I know that's a red flag in this sub right now, and I'd rather state it than have someone find it in the commit history and feel misled.

What I'd offer as counter-evidence that it isn't a vibe-coded demo:

- **2,965 tests** — unit tests plus repository-contract tests that run against both SQLite and a real Postgres
- Every behavioural fix gets **mutation-tested**: I revert the fix and require the test to actually go red, because a test that passes for the wrong reason is worthless
- 209 merged PRs, each through automated review rounds before merge; CI gates typecheck + the full suite + a production build
- The release gate installs the built Windows package on a clean runner and requires the app to boot and answer HTTP 200 before any artifact is published

Two bugs that process caught recently — both user-visible, neither a "make the tests pass" fix:

- A crash-recovery path was moving scheduled-patrol jobs into a `queued` state that **no worker ever claims**, so the job sat forever *and* blocked that show from ever being patrolled again.
- When the search backend was unreachable, the app reported "no resources found" instead of "your search source is down." Mine was dead for six days and I — the author — was still misled by my own error message for two hours. That turned into a layered fix: fail-fast validation when you save the address, automatic fallback to a public instance, a settings warning, and the agent is now mechanically forbidden from concluding "this doesn't exist" when all its evidence came from a dead source.

Happy to answer anything, including skeptical questions about the AI part.

---

## ⑤ 发帖后要做的事

1. **盯前 30 分钟**：早期评论决定这帖能不能起来。有人问就快答，尤其「跟 *arr 有啥区别」和「AI 写的靠谱吗」这两类。
2. **准备好这两个高频问题的答案**：
   - *"Why cloud drive instead of local?"* → 服务端转存，36GB 不花本地带宽/空间；国际对应物是 debrid 的 cloud-download。
   - *"Which LLM does it need? Is it expensive?"* → 任何 OpenAI 兼容端点，自带 key；一次获取十几次搜索调用量级。（**注意：如果有人问具体成本，别现编数字 —— 说「没精确统计过」比编一个强。**）
3. **不要为了刷可见度回自己的帖**（版规忌讳，且 Reddit 会降权）。
4. **发帖时机**：美东上午 = 北京时间晚 9–11 点活跃度最高。
