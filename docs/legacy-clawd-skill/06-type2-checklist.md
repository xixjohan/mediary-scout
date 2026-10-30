## Type 2 Execution Checklist

For ongoing series or completed without full collection:

```
□ Steps 1-9: Same as Type 1

□ Step 10: Add to Database
  └── show_id = db.add_show(tmdb_id=..., name=..., season=..., year=..., category=..., quality_pref=..., total_episodes=<from_step_2>)
  └── ⚠️ STOP - Output `show_id=<value>` (non-null integer)

□ Step 11: Update Save Directory
  └── db.update_save_dir(show_id=show_id, save_dir_id=season_dir)
  └── ⚠️ STOP - Output `updated=<count>` and require `updated >= 1`

□ Step 12: Sync with TMDB
  └── shows = db.sync_all(tmdb_client=tmdb)
  └── ⚠️ STOP - Output `missing_after_sync=[...]` for current show
  └── Get Show object for this show to check missing episodes

□ Step 13: Mark Obtained Episodes
  └── Based on episodes actually transferred and verified in Step 8-9
  └── db.mark_obtained(show_id=show_id, episode_codes=["S01E01", ...])
  └── ⚠️ STOP - Output `marked=<count>` and `episode_codes=[...]`

□ Step 14: Report Status
  └── Report: "Tracking initialized for X, missing Y episodes"
```

---

