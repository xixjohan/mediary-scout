"use client";

import { Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/**
 * The search box. Submitting used to be a NATIVE `<form action>` GET — which is a
 * full document navigation (Next only intercepts <Link>/router.push), so the whole
 * page reloaded and the shell + header visibly flashed. Here onSubmit does a CLIENT
 * soft navigation instead: the prerendered static shell (sidebar + this header)
 * persists and only the results Suspense hole re-fetches — no full-page flash.
 *
 * `action`/hidden `tab` are kept so it still works as a plain GET if JS is off.
 */
export function SearchForm({
  basePath = "/",
  defaultQuery = "",
}: {
  basePath?: string;
  defaultQuery?: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(defaultQuery);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setQuery(defaultQuery);
  }, [defaultQuery]);

  const handleClear = () => {
    setQuery("");
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape") {
      handleClear();
    }
  };

  return (
    <form
      className="search-form"
      role="search"
      action={basePath}
      onSubmit={(event) => {
        event.preventDefault();
        const value = query.trim();
        router.push(`${basePath}?tab=search&q=${encodeURIComponent(value)}`);
      }}
    >
      <input type="hidden" name="tab" value="search" />
      <div className="search-box search-box-large">
        <Search size={18} aria-hidden />
        <input
          ref={inputRef}
          name="q"
          aria-label="搜索媒体"
          placeholder="片名 / 剧名，也可以描述剧情"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {query.trim() ? (
          <button
            type="button"
            className="search-box-clear"
            aria-label="清空关键词"
            onClick={handleClear}
            title="清空关键词"
          >
            <X size={12} aria-hidden />
          </button>
        ) : null}
      </div>
      <button className="primary-button" type="submit">
        <Search size={16} aria-hidden />
        搜索
      </button>
    </form>
  );
}
