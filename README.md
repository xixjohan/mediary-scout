# Mediary Scout

**An agent-driven media library for your cloud drives.** You ask for a movie, show, or anime; an LLM agent scouts resources across your indexers, transfers the best match into your own 115 / Quark drive, verifies what landed, and keeps tracking what's still missing.

[![license](https://img.shields.io/badge/license-see%20LICENSE-blue)](LICENSE) · [中文文档](README.zh-CN.md)

![Mediary Scout — media library](docs/images/library.png)

> **Disclaimer.** Mediary Scout is **open-source, self-hosted software**. It is **not** offered, and never will be offered, as a hosted service — you run your own instance and bring your own drive / LLM / metadata credentials. It performs the same kinds of file operations you could do by hand in your own cloud drive. See [docs/distribution-and-legal-positioning.md](docs/distribution-and-legal-positioning.md) for the project's stance.

## What it is

Most "media automation" either searches well but doesn't know what you're actually missing, or moves files but never verifies what landed. Mediary Scout treats acquisition as a **state problem**, driven by an agent that acts from evidence, not vibes:

- **Multi-drive, brand-extensible** — 115 and Quark today, each a first-class workspace (a tree model: one account, many drives). Adding a new drive brand is a contained plugin.
- **Agent-driven selection** — the agent reads real search results and picks by quality preference, **Chinese-subtitle** needs, and de-duplication, then verifies the transfer after it happens.
- **Tracking & scheduled gap-fill** — season-level state machine; a scheduled sweep comes back only for shows that still have missing episodes.
- **Cloud-native** — it **transfers** shares/magnets straight into your drive (秒传 / save), it does not download to a local disk.

It's for advanced self-hosters comfortable with their own cloud-drive accounts and credentials — not a one-click consumer product.

## Features

| | |
|---|---|
| **Search → acquire** — find a title, hit 获取, the agent takes over | ![search](docs/images/search.png) |
| **Library wall** — what you have, per drive, with missing / airing badges | ![library](docs/images/library.png) |
| **Show detail** — season coverage, gaps, tracking state | ![show](docs/images/show.png) |
| **Realtime activity** — a live queue + agent action ticker while it works | ![activity](docs/images/activity.png) |
| **Notifications** — per-acquisition + daily digest, multi-channel push | ![notifications](docs/images/notifications.png) |
| **Settings** — drives, quality, language, LLM (BYO-key), Prowlarr, PanSou | ![settings](docs/images/settings.png) |

Multiple drives appear as a workspace switcher with per-brand icons:

![drive switcher](docs/images/switcher.png)

## Architecture

A web app enqueues work; a long-running worker drives a sandboxed agent that has narrow, audited powers while the deterministic workflow owns every side effect and re-reads real state to verify.

```mermaid
flowchart LR
    UI["Web UI<br/>(Next.js)"] -->|enqueue| Q["Postgres queue<br/>+ run state"]
    Q --> W["In-process worker"]
    W --> AG["V2 sandbox agent"]
    AG -->|search| SRC["PanSou / Prowlarr"]
    AG -->|transfer| DR["115 / Quark drive"]
    AG -->|read back| DR
    AG -->|verify + mark| Q
    Q -->|realtime| UI
    CRON["Scheduled sweep"] -->|gaps only| Q
```

- State lives in **Postgres** the whole way, so runs are resumable across worker restarts (the agent rebuilds from real drive + DB state, not cached chat history).
- Metadata comes from **TMDB** (with a built-in proxy fallback so it works out of the box); resource search from **PanSou** and optionally **Prowlarr** (torrent/magnet indexers).

## Quick start

The fastest path is Docker Compose (web + Postgres + a bundled PanSou):

```bash
cp .env.example .env   # optional — most config can be set in the UI
docker compose up -d
```

Then open the web UI and, in **Settings**, provide what you want to use (all bring-your-own):

- **A drive** — connect 115 or Quark (QR-scan login, or paste a cookie).
- **TMDB** — works out of the box via a proxy; add your own key for direct access.
- **LLM** — any OpenAI-compatible endpoint (`baseURL` / `apiKey` / `modelId`). The author never sees your key.
- **Prowlarr** *(optional)* — add your indexers for magnet/torrent sources (115 only; Quark has no magnet API).

Full self-host notes: [docs/deploy-compose.md](docs/deploy-compose.md).

## Supported drives

- **115** (`pan115`) — full support, including magnet via Prowlarr.
- **Quark** (`quark`) — share-link transfer (no magnet web API).

New brands plug into a storage-brand registry; the bulk of adding one is a cookie client + a storage executor for that drive's transfer API.

## Status & limitations

- Self-hosted, for advanced users; you need usable 115/Quark access (a membership is most practical).
- Scheduled monitoring is most valuable on an always-on host.
- This is not a hosted product and ships no hosted backend.

## Credits & upstream

Built on top of, and grateful to:

- [PanSou](https://github.com/fish2018/pansou-web) — resource search backend
- [Prowlarr](https://github.com/Prowlarr/Prowlarr) — indexer manager (optional)
- [p115client](https://github.com/ChenyangGao/p115client) — 115 API reference
- [TMDB](https://www.themoviedb.org/) — metadata (this product is not endorsed or certified by TMDB)

Not affiliated with 115, Quark, TMDB, or any indexer. Mediary Scout is an independent, disciplined workflow built around these pieces.
