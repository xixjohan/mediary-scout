## Directory Structure

The folder names below describe the logical target layout.
The authoritative targets are the configured CID values from environment, not hardcoded literals in this document.

```
clawd-media/
├── Movies/
│   └── 电影名 (年份)/
│       └── 视频文件
├── TV Shows/
│   └── 剧名 (年份)/
│       └── Season 1/
│           └── 视频文件
└── Anime/
    └── 动漫名 (年份)/
        └── Season 1/
            └── 视频文件
```

**Directory target keys**:
- Root media directory: `CLAWD_MEDIA_ROOT_CID`
- Movies: `MOVIES_CID`
- TV Shows: `TV_SHOWS_CID`
- Anime: `ANIME_CID`

---

## Common Mistakes to Avoid

### 1. Slicing Collections

```python
# ❌ WRONG - Will raise ValueError
links = pansou.extract_all_links(...)
links[:5]  # FORBIDDEN

# ✅ CORRECT
links = pansou.extract_all_links(...)
all_links = []
links.each(lambda i, link: all_links.append(link))  # ALL links
```

### 2. For-loop on Collections

```python
# ❌ WRONG - Will raise ValueError
for link in links:
    print(link)

# ✅ CORRECT
links.each(lambda i, link: print(link))
```

### 3. Lazy Callback

```python
# ❌ WRONG - Only processes first 5
links.each(lambda i, link: print(link) if i < 5 else None)

# ✅ CORRECT - Processes ALL
links.each(lambda i, link: print(link))
```

### 4. Multi-step Scripts

```python
# ❌ WRONG - No decision points
result = pansou.search(...)
links = pansou.extract_all_links(...)
all_links = []
links.each(lambda i, link: all_links.append(link))
pan115.transfer(...)
pan115.flatten_directory(...)

# ✅ CORRECT - Step by step with STOPs
result = pansou.search(...)
# ⚠️ STOP

links = pansou.extract_all_links(...)
all_links = []
links.each(lambda i, link: all_links.append(link))
# ⚠️ STOP - Output `evidence=[...]`, `decision=<action|skip>`, `reason=<evidence-linked>`
```

---

## Summary

1. **Use `.each()` method** for all collections - never slice or for-loop
2. **One step = one decision point** - stop and analyze after each meaningful operation
3. **Agent intelligence is for decisions** - which resources to use, whether to proceed
4. **Batch execution is for already-decided actions** - transferring selected URLs
5. **Always verify** - check success returns, verify files landed
