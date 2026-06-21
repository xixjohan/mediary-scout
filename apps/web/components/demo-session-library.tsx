"use client";

import { Check } from "lucide-react";
import { isDemoModeClient } from "../lib/demo-mode";
import { useDemoAcquisitions } from "../lib/use-demo-session";

/**
 * Read-only demo: a top "本次演示获取" section showing the titles the visitor
 * "acquired" this session (client-only sessionStorage — no DB, no server render).
 * Mounted in the library's static shell (NOT inside the streaming Suspense) so it
 * actually hydrates. Renders nothing outside demo or when empty.
 */
export function DemoSessionLibrary() {
  const entries = useDemoAcquisitions();

  if (!isDemoModeClient() || entries.length === 0) {
    return null;
  }

  return (
    <div className="category-section" aria-label="本次演示获取">
      <div className="category-header is-static">
        <h2>本次演示获取 {entries.length}</h2>
      </div>
      <div className="poster-row">
        {entries.map((e) => (
          <div className="wall-card" key={`${e.type}_${e.tmdbId}`} title="本次演示获取（仅本次浏览）">
            <span className="wall-poster">
              {e.posterPath ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`https://image.tmdb.org/t/p/w342${e.posterPath}`} alt="" loading="lazy" />
              ) : (
                <span className="poster-fallback">{e.title.slice(0, 4)}</span>
              )}
              <span className="wall-states">
                <span className="wall-state tone-green" title="已获取">
                  <Check size={13} aria-hidden />
                </span>
              </span>
            </span>
            <span className="wall-copy">
              <strong>{e.title}</strong>
              <span>{e.year} · 已获取</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
