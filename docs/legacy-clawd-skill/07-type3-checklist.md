## Type 3 Execution Checklist

For scheduled monitoring (sub-agent cron job):

```
□ Step 1: Sync All Shows
  └── shows = db.sync_all(tmdb_client=tmdb)
  └── ⚠️ STOP - Evidence required:
      └── Print the number of shows returned
      └── Print EVERY show that has missing episodes (show.name, show.season, show.missing)
      └── Do not skip items (no "I'll just handle top 3")

□ Step 2: For Each Show with Missing Episodes
  └── Report: "Processing: {show.name}, missing: {show.missing}"

□ Step 3: Check Existing Files in 115
  └── snap = pan115.list_video_files_snapshot(cid=show.save_dir_id)
  └── all_videos = []
  └── snap.each(lambda i, v: all_videos.append(v))
  └── ⚠️ STOP - Evidence required:
      └── Print EVERY existing video file with its index: [i] name + size + fid
      └── No truncation (`[:N]`, top-N, "...and N more") is allowed
      └── In plain language, state what episodes you already see and how that affects missing episodes

□ Step 3b: Verify Missing vs Existing Coverage (CRITICAL BRANCH)
  └── Compare `show.missing` episodes against files found in Step 3
  └── If ALL missing episodes already exist in 115 (verified by filename analysis):
      └── Report: "{show.name}: All missing episodes already exist in 115, skipping search/transfer"
      └── ⚠️ STOP - Jump directly to Step 10 (Mark Obtained)
      └── ⚠️ STOP - Output `skip_reason=ALREADY_EXISTS, episodes=[...]`
  └── If SOME missing episodes exist (partial coverage):
      └── Report: "{show.name}: Partial coverage - existing {episodes_found}, still missing {episodes_still_missing}"
      └── Update tracking to only search for still-missing episodes
      └── Continue to Step 4 (search only for uncovered episodes)
  └── If NO missing episodes exist (Step 3 shows no coverage):
      └── Continue to Step 4 (full search required)

□ Step 4: Pansou Search
  └── pansou.search(show.name)
  └── ⚠️ STOP - Evidence required:
      └── 必须同时报告：115_count=X, magnet_count=Y（两者缺一不可）
      └── 如果任一类 count>0，必须在后续步骤中提取并分析该类链接
      └── 禁止在没展示链接前就下"XX链接不可用"的结论

□ Step 5: Extract and Analyze Links
  └── 必须分别提取 115 链接和 magnet 链接：
      └── links_115 = pansou.extract_all_links(result["115"], "115") 如果 115_count>0
      └── links_magnet = pansou.extract_all_links(result["magnet"], "magnet") 如果 magnet_count>0
      └── 只要 count>0，就必须用 .each() 遍历全部并展示标题
  └── Freeze the same result set with `snapshot = pansou.extract_link_snapshot(...)`
  └── ⚠️ STOP - Evidence required:
      └── Print EVERY link title with an index: [i] title
      └── No truncation (`[:N]`, top-N, "...and N more") is allowed
      └── 分别展示 115 链接和 magnet 链接的分析结果
      └── **MANDATORY: Explicit episode mapping (one line per link)**
          └── Format: "[i] {title} → Episode: {X} | Select: {YES/NO} | Reason: {...}"
          └── Example: "[3] 七王国的骑士.S01E06.1080p → Episode: E06 | Select: YES | Reason: Matches missing E06"
          └── Example: "[4] 七王国的骑士.S01E02.1080p → Episode: E02 | Select: NO | Reason: Wrong episode (E02 not E06)"
      └── **VERIFY: Missing episodes are {show.missing}, confirm selected links cover EXACTLY these**
      └── If ANY link's episode cannot be determined from title → SKIP that link
      └── If missing episode not found in any link → Report "No covering resource found"
      └── Output `chosen_indices=[...]` and `plan.snapshot_id=<id>` (create exactly one plan from SAME snapshot for Step 7)
  └── Selection safety (Type 3):
      └── 优先选择精确匹配缺失集数的小范围资源
      └── 如果选中的分散资源存在缺口（如缺 E08），必须同时选择能补齐该缺口的季包/全集包
      └── 禁止因为"避免大包"而放弃唯一能覆盖缺失集数的资源
      └── If you still choose a massive pack, justify the tradeoff (coverage/quality vs dedup risk)
  └── Apply Rule 7 (no "just in case" transfers)
  └── Apply Rule 8 (strict season matching if show.season > 1)

□ Step 5b: Honesty Principle
  └── 禁止编造结论
  └── 如果某部分无法确定，必须写"不确定/待验证"
  └── 绝对禁止写"没有"、"不可用"或"资源不存在"等绝对化表述（除非已经完整遍历并验证）

□ Step 6: Decision Point
  └── If NO resource covers missing episodes:
      └── Report: "No covering resource found for {show.name}"
      └── ⚠️ STOP - Output `skip_show_id=<id>, skip_reason=NO_COVERAGE, uncovered_missing=[...]`
  └── If resource found:
      └── Continue to Step 7

□ Step 7: Transfer
  └── Execute only the `TransferPlan` created in Step 5
  └── Forbidden: re-extract links then `all_links[i]` lookup at execution time
  └── Forbidden: re-search same keyword and create a fresh plan after the decision step
  └── `pan115.execute_transfer_plan(plan=plan, save_dir_id=show.save_dir_id)`
  └── ⚠️ STOP - Output per-item `success/msg` from transfer result

□ Step 8: Flatten Directory
  └── Safety check before flatten:
      └── `show.save_dir_id` must be the final landing directory for this tracked season
      └── It must NOT be `0`, `CLAWD_MEDIA_ROOT_CID`, `MOVIES_CID`, `TV_SHOWS_CID`, or `ANIME_CID`
      └── It must resolve to a season leaf directory for this show (for example `.../Season 1`)
      └── If the target/path looks wrong, STOP and report `skip_show_id=<id>, skip_reason=UNSAFE_TARGET`
  └── pan115.flatten_directory(dir_id=show.save_dir_id)
  └── ⚠️ STOP - Output `moved=<n>, removed=<n>` and require both numeric
  └── NOTE: `flatten_directory()` is synchronous and may take a long time on big folders.
      It prints `[FLATTEN] ...` output (with flush + heartbeat). Do NOT background-poll or kill it.

□ Step 9: List and Deduplicate
  └── snap = pan115.list_video_files_snapshot(cid=show.save_dir_id)
  └── all_videos = []
  └── snap.each(lambda i, v: all_videos.append(v))
  └── ⚠️ STOP - Output `file_episode_map={index:episode_key}` (semantic mapping, not suffix pattern)
  └── ⚠️ STOP - Output `duplicate_groups={episode:[indices...]}` and `candidate_delete_indices=[...]`
  └── If you print evidence, print ALL items; no truncation is allowed
  └── Identify duplicate indices (same episode, smaller file)
  └── If duplicates found:
      └── **PREVIEW first (MANDATORY)**:
          └── preview = pan115.preview_snapshot_deletions(indices=[...], snapshot=snap)
          └── Review preview["to_delete"] and preview["to_keep"]
          └── ⚠️ STOP - Output `planned_indices=[...]` and `preview.to_delete[].index=[...]`; require exact match
      └── result = pan115.delete_snapshot_files(indices=[...], snapshot=snap)
      └── ⚠️ STOP - Output `ok=<bool>, code=<str>, deleted=<n>, failed=<n>`
      └── verify_snap = pan115.list_video_files_snapshot(cid=show.save_dir_id)
      └── ⚠️ STOP - Output `duplicate_groups_after={episode:[indices...]}` and require all groups size == 1

□ Step 10: Mark Obtained
  └── ⚠️ BEFORE marking, verify physical files exist in 115 for ALL episodes you plan to mark
  └── Known issue: after flatten_directory, some files may disappear (e.g., E09/E10 vanished)
  └── Cross-reference Step 9 all_videos list against the episode_codes you plan to mark
  └── If an episode is in DB as missing but NOT found in Step 9 file list, do NOT mark it obtained
  └── db.mark_obtained(show_id=show.show_id, episode_codes=[...])
  └── ⚠️ STOP - Output `marked=<count>` and `episode_codes=[...]` for this show

□ Step 11: Report Per-Show Result
  └── Report: "{show.name}: obtained {episodes}, still missing {remaining}"

□ Step 12: Repeat Steps 2-11 for Next Show

□ Step 13: Final Summary
  └── Report: "Task complete. X shows processed, Y episodes obtained, Z still missing"
```

---
