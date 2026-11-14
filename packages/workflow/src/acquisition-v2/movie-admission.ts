/**
 * A movie is ONE playable video file. These resource shapes can never become
 * that, so they are refused before any transfer — prompt guidance alone let a
 * 蓝光原盘合集 through and burned the whole quota on an unplayable dump.
 */
const DISC_IMAGE = /(?:^|[\s._\-/[(])(?:iso|bdmv|bd-?iso)(?:$|[\s._\-/\])])|蓝光原盘|原盘|整盘镜像/i;
const MULTI_FILM = /合集|部曲|\d+\s*[-–~]\s*\d+\s*部|collections?|box\s*set|trilogy|quadrilogy/i;

/** Why this resource name can never be a single film, or null when it can. */
export function movieCandidateRejection(title: string): "disc_image" | "multi_film_pack" | null {
  if (DISC_IMAGE.test(title)) return "disc_image";
  if (MULTI_FILM.test(title)) return "multi_film_pack";
  return null;
}

/** Extras that sit beside a film but are not the film (name only — a real film
 *  can be small, so size never decides this). */
const EXTRA_VIDEO = /trailer|sample|preview|featurette|花絮|预告|片花/i;

export function isExtraVideoName(name: string): boolean {
  return EXTRA_VIDEO.test(name);
}