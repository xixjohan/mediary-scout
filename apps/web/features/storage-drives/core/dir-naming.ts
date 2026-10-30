export function customDirNamesFromEnv(env: NodeJS.ProcessEnv): {
  rootName?: string;
  moviesName?: string;
  tvName?: string;
  animeName?: string;
} {
  const opts: { rootName?: string; moviesName?: string; tvName?: string; animeName?: string } = {};
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
