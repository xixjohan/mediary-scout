# Environment Contract

This skill is environment-driven.

It assumes bootstrap has already prepared a local `.env` (or equivalent process environment)
with the required values below.

If any required value is missing, the run is **not bootstrap-complete**.
Stop and fix bootstrap/config first instead of improvising.

---

## Required Keys

### Runtime / External Services

- `TMDB_READ_TOKEN`
  - Used by `TMDBClient()`
  - This is the TMDB read token, not a numeric TMDB ID
- `PANSOU_BASE_URL`
  - Used by `PansouClient()`
  - Must be a reachable PanSou base URL
  - Bootstrap can satisfy this in two ways:
    - write the repository's verified public service URL after the human chooses the public path
    - or write a self-hosted deployment URL after the human chooses self-hosting
  - Users who self-host should replace the default with their own deployment URL
- `PAN115_COOKIE`
  - Used by `Pan115Client()`
  - Must be a valid authenticated cookie string for the target 115 account

### 115 Directory Targets

- `CLAWD_MEDIA_ROOT_CID`
  - Root media directory CID
  - Parent of the three category directories below
- `MOVIES_CID`
  - Target parent for movie acquisitions
  - Movie jobs create a leaf directory under this CID: `电影名 (年份)`
- `TV_SHOWS_CID`
  - Target parent for TV show acquisitions
  - TV jobs create a show directory under this CID, then a `Season N` directory inside it
- `ANIME_CID`
  - Target parent for anime acquisitions
  - Anime jobs follow the same pattern as TV: title directory, then `Season N`

### Directory Relationship

The expected shape is:

`CLAWD_MEDIA_ROOT_CID`  
→ `MOVIES_CID` / `TV_SHOWS_CID` / `ANIME_CID`  
→ final landing directories created by the workflow

These CIDs are not interchangeable.
Category parents are bootstrap targets.
Final landing directories are created during Type 1 / Type 2 execution.

---

## Agent Rules

1. Do not hardcode any CID in reasoning or execution.
2. Use the environment-backed configuration as the source of truth.
3. Do not ask for API keys/cookies during normal Type 1/2/3 execution.
   If they are missing, the correct action is to stop and report bootstrap incomplete.
4. Do not pass secrets directly in code when constructor defaults already read from environment.
5. Do not treat category-parent CIDs as final working directories for flatten/dedup operations.

---

## What Bootstrap Must Guarantee

Before this skill is considered production-ready on a machine, bootstrap must ensure:

1. The required environment keys above are present.
2. The referenced CIDs actually exist in 115.
3. The root media structure is initialized.
4. The local Python environment is ready.

If those guarantees are missing, this is a bootstrap/setup problem, not a Type 1/2/3 execution problem.
