/**
 * Collapse a list of episode codes into contiguous ranges for compact display.
 * A 169-episode acquisition rendered as 169 chips makes the notification card
 * absurdly tall (and stretches the poster). As ranges it's 2-3 tokens:
 *   ["E01".."E164", "E170", "E175".."E178"] → ["E01–E164", "E170", "E175–E178"]
 * The trailing integer of each code is the episode number; the original code
 * strings are kept as the range endpoints, so a season prefix survives
 * ("S06E04–S06E06").
 */
function episodeNumber(code: string): number {
  const match = code.match(/(\d+)\s*$/);
  return match ? Number(match[1]) : Number.NaN;
}

export function collapseToRanges(codes: string[]): string[] {
  const sorted = codes
    .filter((code) => Number.isFinite(episodeNumber(code)))
    .sort((a, b) => episodeNumber(a) - episodeNumber(b));

  const ranges: string[] = [];
  let start: string | null = null;
  let end: string | null = null;

  const flush = () => {
    if (start !== null) {
      ranges.push(start === end ? start : `${start}–${end}`);
    }
  };

  for (const code of sorted) {
    if (start === null) {
      start = code;
      end = code;
    } else if (episodeNumber(code) === episodeNumber(end as string) + 1) {
      end = code;
    } else {
      flush();
      start = code;
      end = code;
    }
  }
  flush();
  return ranges;
}
