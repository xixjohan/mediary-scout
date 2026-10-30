// Live e2e: a FAKE user TMDB key must fail direct, then fall back to the proxy
// Worker (author key) and still return real metadata. Run: npx tsx scripts/tmdb-fallback-e2e.mts
import { createTmdbMetadataProvider, TMDB_DIRECT_BASE_URL } from "@media-track/workflow";

const PROXY = "https://media-track-tmdb-proxy.fancydirty.workers.dev";

async function main() {
  // 1. fake key with NO proxy → must throw (proves the direct call really fails)
  const directOnly = createTmdbMetadataProvider([{ baseURL: TMDB_DIRECT_BASE_URL, readToken: "FAKEKEY_definitely_invalid" }]);
  let directFailed = false;
  try {
    await directOnly.getMovieDetails(278);
  } catch {
    directFailed = true;
  }
  console.log(`fake-key-direct-only throws: ${directFailed}`);
  if (!directFailed) throw new Error("expected fake key direct call to fail");

  // 2. fake key THEN proxy → must fall back and return real data (id 278)
  const withFallback = createTmdbMetadataProvider([
    { baseURL: TMDB_DIRECT_BASE_URL, readToken: "FAKEKEY_definitely_invalid" },
    { baseURL: PROXY },
  ]);
  const movie = await withFallback.getMovieDetails(278);
  console.log(`fallback movie id=${movie.id} title=${movie.title}`);
  if (movie.id !== 278) throw new Error(`expected id 278 via fallback, got ${movie.id}`);

  console.log("✅ fallback e2e passed: fake key → proxy → real metadata");
}

main().catch((error) => {
  console.error("❌", error);
  process.exit(1);
});
