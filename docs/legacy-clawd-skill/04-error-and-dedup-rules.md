## Error Handling

### Network Errors (ConnectionError, Timeout, 502/503)

```python
# Error: requests.exceptions.ConnectionError / 502 Bad Gateway
# Cause: Network fluctuation
# Action: Wait 15 seconds, retry. Report after 3 consecutive failures.
```

### Pansou Returns Empty Results (0 resources)

```python
# Scenario: pansou.search() returns {"115": [], "magnet": []}
# 
# This could mean:
# 1. Network fluctuation (request succeeded but data incomplete)
# 2. Truly no resources available
#
# Action:
# 1. Check if search completed normally (no exception raised)
# 2. If no exception but empty results → Wait 10 seconds, retry search
# 3. After 3 retries still empty → Accept "no resources" and report
#
# ⚠️ CRITICAL: Do NOT proceed to transfer if no resources found!
# Do NOT transfer random resources hoping they contain target episodes!
```

### Resource Unavailable (410 Gone, "expired", "失效", "分享已拒绝")

```python
# Error: Resource expired / 410 Gone / "分享已拒绝"
# Cause: Normal - resources expire or share is revoked by owner
# Action: Try next resource in list. This is expected behavior.
#
# ⚠️ IMPORTANT: "分享已拒绝" is a very common failure for 115 share links.
# When ALL 115 links return "分享已拒绝", fall back to magnet links:
# 1. Re-search with keyword + year (e.g., "白日提灯 2026")
# 2. Extract magnet links from the new result
# 3. Use magnet transfer as fallback
# This fallback strategy rescued 白日提灯 when 13/13 115 links were refused.
```

### 115 Rate Limit (405, 403, "too many requests")

```python
# Error: 405 Method Not Allowed / 403 Forbidden
# Cause: 115 API rate limit triggered
# Action: Enter Recovery Mode (recoverable).
# Recovery report: Recovery: RateLimit; Step=<N>; RollbackPoint=<last verified step>; CorrectiveAction=<wait 10-30 minutes then retry>; RetryBudget=<2>
# Do NOT retry immediately - this makes it worse.
```

### Authentication Failure

```python
# Error: 401 Unauthorized / "login required"
# Cause: Authentication expired
# Action: Non-recoverable error. Do NOT retry.
# Failure report: Task Failed: AuthenticationExpired; Step=<N>; Evidence=<401/login required>; ViolationSignal=<NON_RECOVERABLE_AUTH>; PlannedAction=<re-auth required>
```

---

## Deduplication Rules (CRITICAL)

When you have duplicate episodes (same episode number, different files), you MUST follow these rules:

### Rule 1: Compare File Size

**ALWAYS keep the LARGER file, delete the SMALLER file.**

```python
# Example: E01 has 2 versions
# File A: "太平年.E01.1080p.mkv" - 500MB
# File B: "太平年.E01.4K.mkv" - 1.5GB
# 
# ✅ CORRECT: Keep File B (1.5GB), delete File A (500MB)
# ❌ WRONG: Keep File A because it's from the old batch
```

### Rule 2: File Size = Quality

| Size | Typical Quality | Action |
|------|----------------|--------|
| > 2GB | 4K/UHD | Keep |
| 1-2GB | 1080p | Keep if no 4K |
| 500MB-1GB | 720p/1080p compressed | Delete if larger exists |
| < 500MB | Low quality | Always delete |

### Rule 3: Flatten First, Then Deduplicate

```python
# Step 1: Flatten (moves all videos to root)
pan115.flatten_directory(dir_id=season_dir)

# Step 2: List ALL videos (now in root, no subfolders)
videos = pan115.list_video_files(cid=season_dir, min_size_gb=0.2)
all_videos = []
videos.each(lambda i, v: all_videos.append({
    'index': i,
    'name': v['n'],
    'size_gb': int(v['s']) / (1024**3),  # Convert bytes to GB
    'fid': v['fid']
}))

# Step 3: Use your intelligence to analyze and decide
# - Extract episode numbers from filenames (understand semantics, don't use regex)
# - Group files by episode number
# - For each group with multiple files: compare sizes, identify smaller ones
# - Build list of indices to delete (the smaller/lower quality duplicates)
# 
# Example decision process:
# E01 has 2 files: file_A (1.2GB), file_B (800MB) → delete file_B (index X)
# E02 has 1 file → keep
# E03 has 2 files: file_C (2.1GB), file_D (1.5GB) → delete file_D (index Y)
# ... and so on

# Step 4: Delete the identified smaller duplicates (snapshot-safe)
duplicate_indices = [index_X, index_Y, ...]  # indices you identified above
snap = pan115.list_video_files_snapshot(cid=season_dir, min_size_gb=0.2)
pan115.preview_snapshot_deletions(indices=duplicate_indices, snapshot=snap)
pan115.delete_snapshot_files(indices=duplicate_indices, snapshot=snap)
```

### Rule 4: Real Example

**Scenario**: Life Tree (生命树)
- Existing: E01-E12 (old files, 1.2GB each, high quality)
- New transfer: E01-E14 (new files, 800MB each, collection pack)
- Missing: E13-E14

**Agent's WRONG action**: Deleted E01-E12, kept E01-E14
**Why WRONG**: Deleted larger (1.2GB) files, kept smaller (800MB) files

**CORRECT action**:
1. After flatten: 26 files in root (E01x2, E02x2, ..., E12x2, E13, E14)
2. For E01-E12: Compare sizes
   - Old: 1.2GB → **KEEP** (larger)
   - New: 800MB → **DELETE** (smaller)
3. For E13-E14: Only one version each → **KEEP**
4. Final: E01-E12 (old, 1.2GB) + E13-E14 (new, 800MB) = 14 episodes

### Rule 5: Use Intelligence, Not Regex

**CRITICAL**: Extract episode numbers by UNDERSTANDING filenames, not by writing regex functions.

✅ **Correct**: Use your intelligence to read and understand
```
"The.Pitt.S02E04.2160p.WEB-DL.mkv" → S02E04
"匹兹堡医护前线.第二季.第4集.4K.mkv" → S02E04
"第2季第4集.1080p.mkv" → S02E04
"2x04.HD.mkv" → S02E04
```

❌ **Wrong**: Writing regex functions like `re.search(r'S(\d+)E(\d+)', filename)`
- Do NOT write helper functions
- Do NOT use regex
- Do NOT use suffix-only matching (`(1)`, `copy`, `副本`) to detect duplicates
- Use your built-in understanding of text

**You are an intelligent agent, not a script. Act like one.**

### Rule 6: Never Keep "Collection Pack" Just Because It's New

**File size is the ONLY criteria.**
- New ≠ Better
- Collection pack ≠ Better
- Larger = Better (higher bitrate/quality)

### Rule 7: No "Just In Case" Transfers (CRITICAL)

**If resource explicitly does NOT cover missing episodes → SKIP immediately**

**If you are not sure the title covers the missing episodes → treat it as NOT covering and SKIP.**
Do not assume coverage from unrelated numbers (years, resolution, codec, etc.).

```
Example: Missing S02E04

Resource: "第二季 更新至03集"
→ Explicitly says "更新至03集" (up to E03)
→ Clearly does NOT include E04
→ SKIP immediately, do NOT transfer "just in case"

Resource: "第二季 1-6集合集"
→ Covers E01-E06
→ Includes E04
→ MUST evaluate for transfer (cite title index)
```

**Common "不死心" excuses to reject:**
- "下载来看看有没有" → NO
- "先转存再说，没有就删" → NO
- "碰运气，万一有隐藏集数" → NO
- "虽然写03集但可能实际有04" → NO

**Rule**: If resource title explicitly limits episodes (e.g., "更新至03集", "1-3集", "前三集"), and missing episode is beyond this range → SKIP immediately.

---

### Rule 8: Match Season Based on Tracking Info (CRITICAL)

When analyzing resources, you MUST check `show.season` from `sync_all()` results:

```python
shows = db.sync_all(tmdb_client=tmdb)
for show in shows:
    track_season = show.season  # The season being tracked
    missing_eps = show.missing   # Missing episodes
    
    # Search resources
    result = pansou.search(show.name)
    
    # Analyze each resource
    for link in all_links:
        if track_season == 1:
            # Season 1 (default for most Chinese dramas)
            # Resources don't need explicit "Season 1" in title
            # Check: Does resource cover missing episodes?
            # Example: "庆余年 全集" or "更新至46集" → OK for season 1
            pass
        else:
            # Season 2, 3, 4... (US/Korean/Japanese dramas)
            # Resources MUST explicitly indicate the correct season
            # 
            # ✅ CORRECT: "第二季 更新至03集", "S02E01-E06", "Season 2"
            # ❌ WRONG: "完结" (likely Season 1), "更新至13集" (no season info)
            #
            # If resource doesn't explicitly show "Season N" where N == track_season:
            # → SKIP, it's probably for a different season
```

**Example - The Pitt (匹兹堡医护前线)**:
```
Tracking: Season 2 (show.season = 2)
Missing: S02E04

Resource A: "匹兹堡医护前线 完结" 
→ No season info → Likely Season 1 → SKIP

Resource B: "更新至13集"
→ No season info → Could be Season 1 Episode 13 → SKIP

Resource C: "第二季 更新至03集"
→ Explicitly Season 2 → Check if covers E04 → No (only E01-E03) → SKIP

Resource D: "第二季 1-6集合集"
→ Explicitly Season 2, covers E01-E06 → Includes E04 → TRANSFER
```

**Key Point**: 
- `show.season == 1`: Flexible matching, focus on episode coverage
- `show.season > 1`: Strict matching, must explicitly match season number

---

## Type 1 vs Type 2 Quick Check

```python
details = tmdb.get_tv_details(tmdb_id)
in_production = details.get("in_production")
last_ep = details.get("last_episode_to_air", {})
latest_episode = last_ep.get("episode_number", 0)
total_episodes = details.get("number_of_episodes", 0)

if not in_production and latest_episode == total_episodes:
    # Completed series with all episodes aired
    # Check Pansou for complete collection
    # If single resource covers all → Type 1
    # If multiple resources needed → Type 2
    pass
else:
    # Still ongoing or incomplete → Type 2 (tracking required)
    pass
```

---

## Multi-Season Shows: Split by Season (CRITICAL)

**For shows with multiple seasons (e.g., Season 1 finished, Season 2 ongoing):**

**DO NOT treat as "Type 1 + Type 2 mixed". Instead: Split by season and process separately.**

### Example: The Pitt (匹兹堡医护前线)

```
The Pitt
├── Season 1 (15 episodes, COMPLETED)
│   └── Process as Type 1: One-time acquisition
│       └── Find complete S1 resource → Transfer → Verify → Done
│
└── Season 2 (Ongoing, currently E01-E03 aired)
    └── Process as Type 2: Initialize tracking
        └── Create S2 directory → Add to DB → Sync TMDB → Transfer missing → Monitor
```

### Decision Process

```python
# Step 1: Get TMDB details
details = tmdb.get_tv_details(tmdb_id)
seasons = details.get("seasons", [])

# Step 2: For each season, determine type
for season in seasons:
    season_number = season.get("season_number")
    episode_count = season.get("episode_count")
    
    # Get last aired episode for this season
    last_ep = details.get("last_episode_to_air", {})
    last_season = last_ep.get("season_number")
    last_episode = last_ep.get("episode_number")
    
    if season_number < last_season:
        # Previous season (completed)
        # → Type 1: One-time acquisition
        process_type1(season_number)
    elif season_number == last_season:
        # Current season
        if details.get("in_production"):
            # Still ongoing → Type 2: Tracking
            process_type2(season_number)
        else:
            # Completed → Type 1: One-time
            process_type1(season_number)
```

### Key Rules

1. **Split by season**: Each season is a separate task
2. **Completed seasons**: Type 1 (one-time, no tracking needed)
3. **Ongoing seasons**: Type 2 (initialize tracking, monitor updates)
4. **Process order**: Complete older seasons first, then ongoing season
5. **Directory structure**: Create separate Season N directories

### Resource Matching by Season

| Season | Type | Resource Matching |
|--------|------|-------------------|
| Season 1 (completed) | Type 1 | `show.season==1`, flexible matching |
| Season 2 (ongoing) | Type 2 | `show.season==2`, strict matching (must prove it's S2) |

**Example Flow**:
```
Show: The Pitt
- S1: Completed, 15 episodes → Type 1
  - Search: "The Pitt Season 1" or "匹兹堡医护前线 第一季"
  - Find: Complete 15-episode resource
  - Transfer → Verify → Done

- S2: Ongoing, E04 missing → Type 2
  - Create: Season 2 directory
  - DB: db.add_show(..., season=2, ...)
  - Search: "The Pitt Season 2" or "匹兹堡医护前线 第二季"
  - Must explicitly match Season 2 (Rule 8)
  - Transfer covering resource → Mark obtained → Monitor
```

---

