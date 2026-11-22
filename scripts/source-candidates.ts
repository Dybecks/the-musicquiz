/**
 * Finds candidate songs for one genre from a real source instead of by hand:
 * Wikidata, the data behind Wikipedia. Songs are taken from Wikidata's genre
 * field (and, for schlager, every Melodifestivalen entry), and ranked by how
 * many Wikipedia languages have an article about them, which is a good
 * measure of how well known a song is. It costs no Spotify requests.
 *
 *   GENRE=schlager npm run source-songs          writes scripts/sources/schlager.md to look through
 *   GENRE=schlager APPLY=1 npm run source-songs  also adds the new songs to scripts/candidates.json
 *
 * TOP=… sets how many of the best-known songs are added (default 150). After
 * APPLY, `GENRE=schlager npm run spotify-data` finds their Spotify ids:
 * Wikidata's own ids first (free), then Spotify search for the rest.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SEARCH_GENRE_DEFS } from '../src/data/searchGenres';
import { songKey } from '../src/spotify/personalDeck';

const file = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SONGS_FILE = file('../src/data/catalog/songs.json');
const CANDIDATES_FILE = file('./candidates.json');
const agent = { 'User-Agent': 'the-musicquiz-precompute/1.0 (https://github.com/Dybecks/the-musicquiz)' };

/** Wikidata genres (English labels) that count as each of the game's genres; their sub-genres count too. */
const WIKIDATA_GENRES: Record<string, string[]> = {
  pop: ['pop music'],
  rock: ['rock music'],
  hiphop: ['hip hop music'],
  rnb: ['contemporary R&B', 'rhythm and blues'],
  soul: ['soul music'],
  disco: ['disco'],
  dance: ['dance music', 'electronic dance music', 'house music', 'Eurodance'],
  country: ['country music'],
  metal: ['heavy metal'],
  indie: ['indie rock', 'indie pop'],
  schlager: ['schlager music', 'Schlager', 'dansband music'],
  swedishpop: ['pop music'],
  jazz: ['jazz'],
  reggae: ['reggae'],
  latin: ['Latin music', 'Latin pop', 'reggaeton', 'salsa music'],
  punk: ['punk rock', 'pop punk'],
};
/** Genres whose songs must come from Sweden (performer or country of origin). */
const SWEDISH_ONLY = new Set(['swedishpop']);
const SWEDEN = 'Q34';

const GENRE = process.env.GENRE ?? '';
const TOP = Number(process.env.TOP || 150);
if (!SEARCH_GENRE_DEFS.some((g) => g.id === GENRE)) {
  console.error(`Set GENRE to one of: ${SEARCH_GENRE_DEFS.map((g) => g.id).join(', ')}`);
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sparql(query: string): Promise<Record<string, { value: string }>[]> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://query.wikidata.org/sparql', {
      method: 'POST',
      headers: { ...agent, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ query }),
    });
    if (res.ok) return ((await res.json()) as { results: { bindings: Record<string, { value: string }>[] } }).results.bindings;
    if (attempt >= 3 || (res.status !== 429 && res.status < 500)) throw new Error(`Wikidata answered ${res.status}`);
    await sleep(Number(res.headers.get('retry-after') || 10) * 1000);
  }
}

/** The Wikidata item for a genre label, matched exactly (case aside). */
async function genreItem(label: string): Promise<string | null> {
  const url = `https://www.wikidata.org/w/api.php?${new URLSearchParams({ action: 'wbsearchentities', search: label, language: 'en', type: 'item', limit: '5', format: 'json' })}`;
  const body = (await (await fetch(url, { headers: agent })).json()) as { search?: { id: string; label?: string; description?: string }[] };
  const hit = body.search?.find((s) => s.label?.toLowerCase() === label.toLowerCase() && /genre|music|style/i.test(s.description ?? ''));
  return hit?.id ?? null;
}

interface Found {
  title: string;
  artist: string;
  year: number;
  fame: number;
  spotify: string | null;
  via: string;
}

function songQuery(where: string, withSubGenres: boolean): string {
  return `SELECT ?song ?songLabel (SAMPLE(?perfLabel) AS ?artist) (MIN(YEAR(?date)) AS ?year) (SAMPLE(?sp) AS ?spotify) (MAX(?links) AS ?fame) WHERE {
  ${where.replace(/GENRE_PATH/g, withSubGenres ? 'wdt:P136/wdt:P279*' : 'wdt:P136')}
  VALUES ?type { wd:Q7366 wd:Q134556 wd:Q105543609 }
  ?song wdt:P31 ?type; wdt:P175 ?perf; wdt:P577 ?date; wikibase:sitelinks ?links.
  OPTIONAL { ?song wdt:P2207 ?sp. }
  ${SWEDISH_ONLY.has(GENRE) ? `{ ?song wdt:P495 wd:${SWEDEN}. } UNION { ?perf wdt:P27 wd:${SWEDEN}. } UNION { ?perf wdt:P495 wd:${SWEDEN}. }` : ''}
  ?perf rdfs:label ?perfLabel. FILTER(LANG(?perfLabel) IN ("en", "sv"))
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,sv". }
} GROUP BY ?song ?songLabel ORDER BY DESC(?fame) LIMIT ${Math.max(TOP * 3, 300)}`;
}

async function songsFor(where: string, via: string): Promise<Found[]> {
  let rows: Record<string, { value: string }>[];
  try {
    rows = await sparql(songQuery(where, true));
  } catch (e) {
    console.log(`  ${via}: ${(e as Error).message} with sub-genres, trying the genres alone.`);
    rows = await sparql(songQuery(where, false));
  }
  return rows
    .map((r) => ({
      title: r.songLabel?.value ?? '',
      artist: r.artist?.value ?? '',
      year: Number(r.year?.value),
      fame: Number(r.fame?.value ?? 0),
      spotify: r.spotify?.value ?? null,
      via,
    }))
    .filter((s) => s.title && !/^Q\d+$/.test(s.title) && s.artist && s.year >= 1950 && s.year <= new Date().getFullYear());
}

async function main(): Promise<void> {
  const items: string[] = [];
  for (const label of WIKIDATA_GENRES[GENRE]) {
    const id = await genreItem(label);
    console.log(`Genre "${label}": ${id ?? 'not found on Wikidata'}`);
    if (id && !items.includes(id)) items.push(id);
    await sleep(500);
  }
  const found: Found[] = [];
  if (items.length) {
    found.push(...(await songsFor(`VALUES ?g { ${items.map((i) => `wd:${i}`).join(' ')} } ?song GENRE_PATH ?g.`, 'genre')));
  }
  if (GENRE === 'schlager') {
    // Every Melodifestivalen entry: songs that took part in (or are part of) an edition of the contest.
    const melfest = `?mf rdfs:label "Melodifestivalen"@sv. ?edition wdt:P31 ?mf. { ?song wdt:P1344 ?edition. } UNION { ?song wdt:P361 ?edition. }`;
    found.push(...(await songsFor(melfest, 'Melodifestivalen')));
  }

  const catalogue = new Set((JSON.parse(readFileSync(SONGS_FILE, 'utf8')) as { title: string; artist: string }[]).map((r) => songKey(r.title, r.artist)));
  const candidates = JSON.parse(readFileSync(CANDIDATES_FILE, 'utf8')) as { title: string; artist: string; year: number; genres: string[] }[];
  const waiting = new Set(candidates.map((r) => songKey(r.title, r.artist)));

  // One row per song, the best-known first; a song found both ways keeps both reasons.
  const byKey = new Map<string, Found>();
  for (const s of found) {
    const key = songKey(s.title, s.artist);
    const had = byKey.get(key);
    if (!had) byKey.set(key, s);
    else if (!had.via.includes(s.via)) had.via += `, ${s.via}`;
  }
  const ranked = [...byKey.values()].sort((a, b) => b.fame - a.fame);
  const status = (s: Found) => (catalogue.has(songKey(s.title, s.artist)) ? 'in the catalogue' : waiting.has(songKey(s.title, s.artist)) ? 'already a candidate' : 'new');
  const fresh = ranked.filter((s) => status(s) === 'new').slice(0, TOP);

  mkdirSync(file('./sources'), { recursive: true });
  const report = [
    `# ${GENRE} songs on Wikidata`,
    '',
    `Written by \`scripts/source-candidates.ts\`. ${ranked.length} songs, the best-known first (fame = Wikipedia languages with an article).`,
    `${fresh.length} new ones ${process.env.APPLY === '1' ? 'were added' : 'would be added (run with APPLY=1)'} to scripts/candidates.json.`,
    '',
    '| Fame | Year | Song | Artist | Spotify id on Wikidata | Found via | Status |',
    '|---:|---:|---|---|---|---|---|',
    ...ranked.map((s) => `| ${s.fame} | ${s.year} | ${s.title} | ${s.artist} | ${s.spotify ?? ''} | ${s.via} | ${status(s)} |`),
    '',
  ].join('\n');
  writeFileSync(file(`./sources/${GENRE}.md`), report);
  console.log(`\n${ranked.length} songs: ${ranked.filter((s) => status(s) === 'in the catalogue').length} in the catalogue, ${ranked.filter((s) => status(s) === 'already a candidate').length} already candidates, ${ranked.filter((s) => status(s) === 'new').length} new.`);
  console.log(`Wrote scripts/sources/${GENRE}.md.`);

  if (process.env.APPLY === '1' && fresh.length) {
    candidates.push(...fresh.map((s) => ({ title: s.title, artist: s.artist, year: s.year, genres: [GENRE] })));
    writeFileSync(CANDIDATES_FILE, '[\n' + candidates.map((r) => ' ' + JSON.stringify(r)).join(',\n') + '\n]\n');
    console.log(`Added ${fresh.length} songs to scripts/candidates.json.`);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
