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
  ['rnb', /\br ?& ?b\b|\brnb\b|rhythm (and|&) blues|\bblues\b|^new jack swing$|^neo soul$/],
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
 * when it has at least half the strongest genre's weight and at least two
 * votes in some source (one vote is often a stray tag); at most two.
 */
export function genresFromTags(...sources: Tags[]): string[] {
  const score = new Map<string, number>();
  const sure = new Set<string>();
  for (const tags of sources) {
    const mine = new Map<string, number>();
    for (const [tag, weight] of tags) {
      if (weight <= 0) continue;
      for (const g of tagGenres(tag)) mine.set(g, (mine.get(g) ?? 0) + weight);
    }
    const top = Math.max(0, ...mine.values());
    for (const [g, w] of mine) {
      score.set(g, (score.get(g) ?? 0) + w / top);
      if (w >= 2) sure.add(g);
    }
  }
  for (const g of score.keys()) if (!sure.has(g)) score.delete(g);
  const best = Math.max(0, ...score.values());
  return [...score.entries()]
    .filter(([, w]) => w >= best / 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([g]) => g);
}

/**
 * The genres a song ends up with: its hand-set genres, plus the ones the tags
 * add. Tags only add: MusicBrainz tags are too thin to take a hand-picked
 * genre away (Johnny B. Goode would lose rock).
 */
export function mergeGenres(handSet: readonly string[], fromTags: readonly string[], order: readonly string[]): string[] {
  const out = new Set([...handSet, ...fromTags]);
  return order.filter((g) => out.has(g));
}
