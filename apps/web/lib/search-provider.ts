/**
 * Which metadata/search provider is live.
 *
 * `MEDIA_TRACK_SEARCH_PROVIDER` used to be read as a branch condition at eight
 * call sites across three files (`=== "tmdb"` here, `!== "tmdb"` there). The bug
 * class that creates is not duplication — it is that "is this the live provider?"
 * had no single definition, so adding a third provider meant finding all eight,
 * and missing one produced a page half on live TMDB and half on the demo
 * provider.
 *
 * It now selects a DEFAULT ENTRY: read it once, fold it into an enum, and the rest
 * of the code asks the enum. Anything that is not "tmdb" is the demo provider —
 * an unset, empty, or misspelled value degrades to demo rather than throwing,
 * because this runs on the search page's hot path.
 */

export type SearchProviderKind = "tmdb" | "demo";

export function searchProviderKind(
  env: Record<string, string | undefined> = process.env,
): SearchProviderKind {
  return env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb" ? "tmdb" : "demo";
}

/** Whether searches hit live TMDB (true) or the built-in demo provider (false). */
export function isLiveSearch(env: Record<string, string | undefined> = process.env): boolean {
  return searchProviderKind(env) === "tmdb";
}
