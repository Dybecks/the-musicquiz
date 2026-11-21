/**
 * Turns genre tags from MusicBrainz and Last.fm into the catalogue's genres
 * (the "By genre" ids in searchGenres.ts). Used by scripts/spotify-precompute.ts,
 * which looks the tags up ahead of time; the game itself never asks.
 */

/** Tag patterns per catalogue genre. A tag can count for several genres ("punk rock"). */
const TAG_GENRES: [genre: string, pattern: RegExp][] = [
  ['pop', /\bpop\b|^europop$|^teen pop$/],
  ['rock', /\brock\b|^grunge$|^britpop$|^new wave$|^rock and roll$|^rock ?n ?roll$|^rockabilly$/],
  ['hiphop', /\bhip ?-?hop\b|\brap\b|^trap$|^g-funk$|^grime$|^drill$/],
  ['rnb', /\br ?& ?b\b|\brnb\b|rhythm (and|&) blues|^new jack swing$|^neo soul$/],
  ['soul', /\bsoul\b|\bfunk\b|^motown$|^gospel$/],
  ['disco', /\bdisco\b/],
  ['dance', /\bdance\b|\bhouse\b|\btechno\b|\btrance\b|\bedm\b|^electro$|^eurodance$|^big room$|^electronic$|^dubstep$|^drum and bass$/],
  ['country', /\bcountry\b|^americana$|^bluegrass$|^honky tonk$/],
  ['metal', /\bmetal\b/],
  ['indie', /\bindie\b/],
  ['schlager', /\bschlager\b|^dansband$|^dansbandsmusik$/],
  ['swedishpop', /^swedish( pop)?$|^svensk|^swedish (indie|rock|dance)/],
  ['jazz', /\bjazz\b|^swing$|^big band$|^bebop$|^bossa nova$/],
  ['reggae', /\breggae\b|^ska$|^dancehall$|^dub$|^rocksteady$/],
  ['latin', /\blatin\b|^reggaeton$|^salsa$|^bachata$|^cumbia$|^merengue$|^latin pop$|^urbano latino$|^bossa nova$/],
  ['punk', /\bpunk\b/],
];

/** Weighted tags: [tag, weight]. */
export type Tags = [tag: string, weight: number][];

/** The genres a tag stands for. */
export function tagGenres(tag: string): string[] {
  const t = tag.toLowerCase().trim();
  return TAG_GENRES.filter(([, re]) => re.test(t)).map(([g]) => g);
}

/**
 * Catalogue genres from one or more sources' tags. Each source counts the
 * same: its weights are scaled so its strongest genre is 1. A genre is kept
 * when it has at least a third of the strongest genre's weight; at most three.
 */
export function genresFromTags(...sources: Tags[]): string[] {
  const score = new Map<string, number>();
  for (const tags of sources) {
    const mine = new Map<string, number>();
    for (const [tag, weight] of tags) {
      if (weight <= 0) continue;
      for (const g of tagGenres(tag)) mine.set(g, (mine.get(g) ?? 0) + weight);
    }
    const top = Math.max(0, ...mine.values());
    for (const [g, w] of mine) score.set(g, (score.get(g) ?? 0) + w / top);
  }
  const best = Math.max(0, ...score.values());
  return [...score.entries()]
    .filter(([, w]) => w >= best / 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([g]) => g);
}

/** Genres that come from where an artist is from, which tags rarely say: kept from the hand-set genres. */
export const KEPT_GENRES = ['swedishpop', 'schlager'];

/**
 * The genres a song ends up with: the sources' genres when they have any,
 * plus the hand-set Swedish ones; otherwise the hand-set genres.
 */
export function mergeGenres(handSet: readonly string[], fromTags: readonly string[], order: readonly string[]): string[] {
  if (fromTags.length === 0) return [...handSet];
  const out = new Set([...fromTags, ...handSet.filter((g) => KEPT_GENRES.includes(g))]);
  return order.filter((g) => out.has(g));
}
