import { isLiveSearch } from "./search-provider";
import {
  createTmdbSearchProvider,
  DoubanSearchProvider,
  getSearchPageView,
  InMemoryMediaSearchCache,
  resolveTitles,
  type MediaSearchProvider,
  type SearchInterpretationCache,
  type SearchPageView,
} from "@media-track/workflow";
import { demoMediaSearchProvider } from "./demo-candidates";
import { getDurableJsonCache } from "./durable-cache";
import { SearchInterpretationCacheAdapter } from "./tmdb-cache";
import {
  ensureDemoSeeded,
  getAccountScopedSettings,
  getActiveWorkspaceScope,
  getAgentModelForSearch,
  getCurrentAccountId,
  getTmdbAccesses,
  getWorkflowRepository,
  resolveTitleResearchOptions,
} from "./workflow-runtime";

let demoSearchCache: InMemoryMediaSearchCache | null = null;
// Description → title memory (see SearchInterpretationCache): the search page
// re-renders every 5s while an acquisition runs, so this must outlive one render.
let interpretationCache: SearchInterpretationCache | null = null;

let doubanFallbackProvider: MediaSearchProvider | null = null;

function getDoubanFallbackProvider(): MediaSearchProvider {
  doubanFallbackProvider ??= new DoubanSearchProvider();
  return doubanFallbackProvider;
}

export async function getSearchView(
  query: string,
  storageId?: string,
  page = 1,
  pageSize = 30,
): Promise<SearchPageView> {
  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  // Tree model: scope a movie's 已获取/获取 state to the active drive — obtained on
  // one drive must stay acquirable on another's workspace.
  const scope = await getActiveWorkspaceScope(storageId);
  const liveTmdb = isLiveSearch();
  const settings = liveTmdb ? getAccountScopedSettings(await getCurrentAccountId()) : null;
  const searchModel = settings ? await getAgentModelForSearch(settings) : null;
  return getSearchPageView({
    query,
    page,
    pageSize,
    provider: await getMediaSearchProvider(),
    fallbackProvider: getDoubanFallbackProvider(),
    cache: getSearchCache(),
    repository,
    scope,
    // Only pass resolveTitles when the account actually has a BYO model
    // configured — otherwise an unconfigured search would cache `{ title: null }`
    // and block resolution even after the user configures a model.
    ...(liveTmdb
      ? {
          interpretations: getInterpretationCache(),
          ...(searchModel && settings
            ? { resolveTitles: (descriptive: string) => resolveSearchTitlesWithModel(descriptive, searchModel, settings) }
            : {}),
        }
      : {}),
  });
}

/** 纯 SQLite 持久化（任务单 S1.4b）：所有环境共用同一个 durable store。 */
function getInterpretationCache(): SearchInterpretationCache {
  if (interpretationCache) return interpretationCache;
  interpretationCache = new SearchInterpretationCacheAdapter(getDurableJsonCache());
  return interpretationCache;
}

/**
 * Turn "男主带小绿瓶修仙的国漫" / "咒术回战 死灭回游" into real titles with the
 * ACCOUNT'S OWN model (Settings → AI 模型), plus web search that routes to
 * DeepSeek's own engine when that is their endpoint. Best-effort: a missing
 * model, a timeout or a bad answer just means "no extra titles".
 */
async function resolveSearchTitlesWithModel(
  query: string,
  model: NonNullable<Awaited<ReturnType<typeof getAgentModelForSearch>>>,
  settings: ReturnType<typeof getAccountScopedSettings>,
): Promise<string[]> {
  const web = await resolveTitleResearchOptions(settings);
  // 15s covers one web search (12s) plus the model call. The page is already
  // inside Suspense, and only a zero-result search pays this at all.
  return resolveTitles({ query, model, web: web.web, timeoutMs: 15_000 });
}

function getSearchCache() {
  // Live TMDB searches are cached durably in SQLite (6h TTL) so casual browsing
  // never becomes an API storm; the demo provider stays in-memory.
  if (isLiveSearch()) {
    return getDurableJsonCache();
  }
  demoSearchCache ??= new InMemoryMediaSearchCache();
  return demoSearchCache;
}

async function getMediaSearchProvider(): Promise<MediaSearchProvider> {
  if (!isLiveSearch()) {
    return demoMediaSearchProvider;
  }
  // Built per-call scoped to the current account (its TMDB key → global → proxy),
  // not module-cached — a singleton would lock to the first account's key.
  return createTmdbSearchProvider(await getTmdbAccesses(getAccountScopedSettings(await getCurrentAccountId())));
}
