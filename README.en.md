<p align="center">
  <img src="docs/images/hero.svg" alt="Mediary Scout" width="600">
</p>

<p align="center">
  <b>Mediary Scout</b><br>
  <b>An AI agent-driven media library for your own cloud drives.</b>
</p>

<p align="center">
  <a href="https://github.com/xixjohan/mediary-scout/actions/workflows/ci.yml"><img src="https://github.com/xixjohan/mediary-scout/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/xixjohan/mediary-scout/releases/latest"><img src="https://img.shields.io/github/v/release/xixjohan/mediary-scout?display_name=tag" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-0BSD-blue" alt="license"></a>
</p>

<p align="center">
  <a href="https://github.com/xixjohan/mediary-scout/releases/latest">📥 Download Desktop App</a> ·
  <a href="#-docker-deployment-recommended">🐳 Docker Deployment</a> ·
  <a href="#-core-features--latest-optimizations">✨ Core Features</a> ·
  <a href="docs/deploy.md">📖 Detailed Deploy Guide</a> ·
  <a href="README.md">中文</a>
</p>

---

## 💡 What is Mediary Scout?

Simply ask for a movie, TV show, anime, or even a plot description; the AI Agent automatically searches for the best resource match across the internet, transfers it straight into your own cloud drives, reads back to verify successful delivery, and continuously patrols to backfill newly released episodes.

> [!NOTE]
> This project actively participates in and endorses the [LINUX DO Community](https://linux.do), where many users self-host, share cloud drive experiences, and get fast deployment support. [![LINUX DO](https://img.shields.io/badge/LINUX%20DO-Endorsed-2ecc71?style=flat&labelColor=1f1f1f)](https://linux.do)

![Mediary Scout: Search a title, click 获取, and the agent searches, transfers, and verifies it into your drive](docs/images/demo.gif)

---

## ✨ Core Features & Latest Optimizations

### 1. 🗂️ Broad Multi-Drive Ecosystem
- **Quark (夸克)**: QR code scan login, Cookie connection, share-link batch transfer & verification;
- **115 Drive**: QR code scan login, share-link transfer, offline torrent/magnet downloads;
- **123 Pan**: QR code scan login, share links & magnet downloads, free accounts supported;
- **Tianyi Cloud (天翼云盘)**: QR scan login, Personal & Cloud Family transfer support;
- **GuangYaPan (光鸭云盘)**: Device code QR & token login, share link & magnet transfer;
- **UC Drive**: Mobile QR scan login and cookie support;
- **Enterprise-grade Credential Security**: Credentials and tokens encrypted with **AES-256-GCM** hardware-level encryption.

### 2. 🔍 High-Availability Search & Metadata
- **TMDB + Douban Dual Engine**: TMDB metadata integrated with **Douban Frodo WeChat API Fallback Provider** (transparent failover ensures 100% coverage for Chinese titles and niche content);
- **Douban Ratings Integration**: Batch asynchronous rating badges (e.g. `⭐ 8.5`) seamlessly embedded in discovery feeds and search cards;
- **Progressive Streaming Search**: Built on React Suspense + PPR (Partial Prerendering) for millisecond skeleton rendering and real-time streaming results;
- **Multi-Category & Tag Filter Bar**: One-click switching across Movies, TV Series, Anime, Variety, and Documentaries with dynamic genres, release year slicing, and popularity/rating sorting;
- **Windowed Pagination with Dynamic Switcher**: Freely switch between **20, 30, and 50 items per page** (default upgraded to **30 items**), backed by concurrent window slicing adapters.

### 3. 🤖 Resilient AI Acquisition Agent
- **OpenAI-Compatible LLM Protocol**: Works with DeepSeek, GPT-4o, Claude 3.5, Qwen 2.5, Kimi, Ollama, vLLM, etc., with a complimentary public model pool out of the box;
- **AI 503 & Filter Interception Resilience**:
  - `PromptSanitizer`: Filters sensitive keywords to prevent model safety blocking;
  - `AgentReflection`: Auto-detects 503 overloads or safety triggers and applies exponential backoff prompt self-healing;
- **Multi-Source Aggregation**: Integrated PanSou resource engine, Haisou provider, and optional Prowlarr indexers.

### 4. 💬 Interactive Chat Assistant with Multi-Session Persistence
- **Parallel Sessions & History**: Create new chats, switch between historical conversations, rename, and clear sessions;
- **Interactive Media Cards**: Automatically identifies media entities in chat and embeds clickable cards with posters, Douban ratings, and 1-click acquisition buttons.

### 5. 🛡️ Zero-Downtime Deployment & Asset Resilience
- **Asset Integrity Gate (`check-build-assets`)**: Verifies 100% of HTML and Manifest chunk references physically exist on disk before release;
- **Client `ChunkLoadError` Auto-Recovery**: Global ErrorBoundary catches deployment chunk drift and safely auto-reloads once via sessionStorage debounce.

---

## 🐳 Docker Deployment (Recommended)

Mediary Scout runs as a **single-image, multi-service architecture** on Docker Compose:
- **`web`**: Next.js SSR + Client application;
- **`worker`**: Dedicated background patrol & acquisition queue host (sharing the same image);
- **`pansou`**: Bundled resource search service;
- **SQLite Single Engine**: Zero external database containers required. All data resides in a single `/app/data/mediary.db` volume.

### Method 1: Docker Compose (Official Recommendation)

```bash
# 1. Clone repository
git clone https://github.com/xixjohan/mediary-scout.git && cd mediary-scout

# 2. Copy environment template
cp .env.example .env

# 3. Pull published images and launch
docker compose pull web worker
docker compose up -d
```

Open `http://<host-ip>:3000` in your browser. Go to **Settings**, scan your drive QR code, and you are ready to go!

---

### Method 2: Docker CLI Single Container

```bash
docker run -d \
  --name mediary-scout \
  -p 3000:3000 \
  -v mediary-data:/app/data \
  --restart unless-stopped \
  ghcr.io/xixjohan/mediary-scout:latest
```

---

### Method 3: Remote Access & Network Accelerations

#### 1. Outbound Proxy for Mainland China (TMDB Access)
If TMDB API is restricted in your region, configure your outbound proxy in `.env`:
```env
HTTP_PROXY=http://172.17.0.1:7890
HTTPS_PROXY=http://172.17.0.1:7890
NO_PROXY=localhost,127.0.0.1,web,worker,pansou
```

#### 2. Remote Access via Cloudflare Tunnel
Set your tunnel token in `.env`:
```env
TUNNEL_TOKEN=your_cloudflare_tunnel_token
```
Launch with the tunnel profile:
```bash
docker compose --profile tunnel up -d
```
> [!CAUTION]
> Always set a login password or protect your domain with Cloudflare Access before exposing it to the public internet.

---

## 💻 Desktop App (macOS & Windows)

| Platform | Download | Note |
| :--- | :--- | :--- |
| **macOS (Apple Silicon)** | [Download .dmg](https://github.com/xixjohan/mediary-scout/releases/latest) | Signed & notarized |
| **Windows (x64)** | [Download .exe](https://github.com/xixjohan/mediary-scout/releases/latest) | Click "More info" → "Run anyway" if SmartScreen prompts |

---

## 📚 More Documentation

- [📖 Full Deployment Guide (NAS, Routers, Tunnels)](docs/deploy.md)
- [🧩 Architecture Overview](docs/architecture.md)
- [🤖 Agent API Specification](docs/agent-api.md)
- [🛡️ Zero-Downtime & ChunkLoadError Architecture](docs/nextjs-chunk-load-and-zero-downtime-deployment-architecture.md)
- [⚖️ Cloud Drive Evaluations](docs/drive-brand-evaluations.md)

---

## ⚖️ Disclaimer

Mediary Scout is open-source, self-hosted software. It is not, and never will be, offered as a hosted cloud service. Users provide their own cloud drive credentials and AI model endpoints.

Not affiliated with 115, Quark, Alibaba, Baidu, 123, Tianyi, GuangYaPan, TMDB, Douban, or any indexer.

---

<p align="center">
  <b>If Mediary Scout helps you, please consider giving it a ⭐️ Star on GitHub!</b>
</p>
