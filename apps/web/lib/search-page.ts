import {
  createTmdbSearchProvider,
  getSearchPageView,
  InMemoryMediaSearchCache,
  type MediaSearchProvider,
  type SearchPageView,
} from "@media-track/workflow";
import { demoMediaSearchProvider } from "./demo-candidates";
import { PostgresMediaSearchCache } from "./tmdb-cache";
import {
  ensureDemoSeeded,
  getAccountScopedSettings,
  getCurrentAccountId,
  getTmdbAccesses,
  getWorkflowRepository,
  postgresConnectionString,
} from "./workflow-runtime";

let demoSearchCache: InMemoryMediaSearchCache | null = null;
let durableSearchCache: PostgresMediaSearchCache | null = null;

export async function getSearchView(query: string): Promise<SearchPageView> {
  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  return getSearchPageView({
    query,
    provider: await getMediaSearchProvider(),
    cache: getSearchCache(),
    repository,
  });
}

function getSearchCache() {
  // Live TMDB searches are cached durably in SQLite (6h TTL) so casual
  // browsing never becomes an API storm; the demo provider stays in-memory.
  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb") {
    durableSearchCache ??= new PostgresMediaSearchCache({ connectionString: postgresConnectionString() });
    return durableSearchCache;
  }
  demoSearchCache ??= new InMemoryMediaSearchCache();
  return demoSearchCache;
}

async function getMediaSearchProvider(): Promise<MediaSearchProvider> {
  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER !== "tmdb") {
    return demoMediaSearchProvider;
  }
  // Built per-call scoped to the current account (its TMDB key → global → proxy),
  // not module-cached — a singleton would lock to the first account's key.
  return createTmdbSearchProvider(await getTmdbAccesses(getAccountScopedSettings(await getCurrentAccountId())));
}
