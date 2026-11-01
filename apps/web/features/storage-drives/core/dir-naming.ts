export interface CustomDirNames {
  rootName?: string | undefined;
  moviesName?: string | undefined;
  tvName?: string | undefined;
  animeName?: string | undefined;
}

export function customDirNamesFromEnv(env: NodeJS.ProcessEnv): CustomDirNames {
  const opts: CustomDirNames = {};
  const pick = (raw: string | undefined): string | undefined => {
    const trimmed = raw?.trim();
    return trimmed ? trimmed : undefined;
  };
  const root = pick(env.MEDIA_TRACK_LIBRARY_ROOT_DIR);
  if (root) opts.rootName = root;
  const movies = pick(env.MEDIA_TRACK_LIBRARY_MOVIES_DIR);
  if (movies) opts.moviesName = movies;
  const tv = pick(env.MEDIA_TRACK_LIBRARY_TV_DIR);
  if (tv) opts.tvName = tv;
  const anime = pick(env.MEDIA_TRACK_LIBRARY_ANIME_DIR);
  if (anime) opts.animeName = anime;
  return opts;
}

export function mergeCustomDirNames(
  base: CustomDirNames,
  overrides?: Partial<CustomDirNames>,
): CustomDirNames {
  if (!overrides) return { ...base };
  return {
    rootName: overrides.rootName?.trim() || base.rootName,
    moviesName: overrides.moviesName?.trim() || base.moviesName,
    tvName: overrides.tvName?.trim() || base.tvName,
    animeName: overrides.animeName?.trim() || base.animeName,
  };
}

export async function resolveCategoryDirNames(
  repositoryGetter: () => {
    getSetting(key: string): Promise<string | null>;
    getAccountSetting?(accountId: string, key: string): Promise<string | null>;
  },
  accountId?: string,
  storageOverride?: Partial<CustomDirNames>,
): Promise<CustomDirNames> {
  try {
    const { resolveLibraryDirNaming } = await import("../../../lib/runtime/settings-readers");
    const config = await resolveLibraryDirNaming(
      repositoryGetter(),
      accountId,
      process.env,
      storageOverride as { rootName?: string; moviesName?: string; tvName?: string; animeName?: string },
    );
    return {
      rootName: config.rootName,
      moviesName: config.moviesName,
      tvName: config.tvName,
      animeName: config.animeName,
    };
  } catch {
    return customDirNamesFromEnv(process.env);
  }
}


