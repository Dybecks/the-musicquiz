/**
 * Finds candidate songs for one genre from a real source instead of by hand:
 * Wikidata, the data behind Wikipedia. Songs are taken from Wikidata's genre
 * field (for schlager instead: every Melodifestivalen and Eurovision entry,
 * and nothing else), and ranked by how
 * many Wikipedia languages have an article about them, which is a good
 * measure of how well known a song is. It costs no Spotify requests.
 *
 *   GENRE=schlager npm run source-songs          writes scripts/sources/schlager.md to look through
 *   GENRE=schlager APPLY=1 npm run source-songs  also adds the new songs to scripts/candidates.json
 *
 * TOP=… sets how many of the best-known songs are added (default 150; schlager
 * takes every contest entry, as Markus asked on 2026-11-22). After
 * APPLY, `GENRE=schlager npm run spotify-data` finds their Spotify ids:
 * Wikidata's own ids first (free), then Spotify search for the rest.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SEARCH_GENRE_DEFS } from '../src/data/searchGenres';
import { normalizeKey, songKey } from '../src/spotify/personalDeck';

const file = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SONGS_FILE = file('../src/data/catalog/songs.json');
const CANDIDATES_FILE = file('./candidates.json');
/** Songs set aside for now: not searched, not in the game, kept so they can be put back. */
const SKIPPED_FILE = file('./skipped.json');
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
const SWEDISH_ONLY = new Set(['swedishpop', 'schlager']);
const SWEDEN = 'Q34';

const GENRE = process.env.GENRE ?? '';
const TOP = Number(process.env.TOP || (GENRE === 'schlager' ? Infinity : 150));
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

/**
 * One query for songs matching `where`. Contest entries (`contest`) are songs by definition and come
 * from the contest's country, so they skip the type and Sweden checks, and take the edition's year
 * (`?edition`, P585) when the song has no publication date.
 */
function songQuery(where: string, withSubGenres: boolean, contest = false): string {
  const swedish = SWEDISH_ONLY.has(GENRE) && !contest;
  return `SELECT ?song ?songLabel (SAMPLE(?perfLabel) AS ?artist) (MIN(YEAR(COALESCE(?date, ?edDate))) AS ?year) (SAMPLE(?sp) AS ?spotify) (MAX(?links) AS ?fame) WHERE {
  ${where.replace(/GENRE_PATH/g, withSubGenres ? 'wdt:P136/wdt:P279*' : 'wdt:P136')}
  ${contest ? 'OPTIONAL { ?edition wdt:P585 ?edDate. }' : 'VALUES ?type { wd:Q7366 wd:Q134556 wd:Q105543609 } ?song wdt:P31 ?type.'}
  ?song wdt:P175 ?perf; wikibase:sitelinks ?links.
  OPTIONAL { ?song wdt:P577 ?date. }
  OPTIONAL { ?song wdt:P2207 ?sp. }
  ${swedish ? `{ ?song wdt:P495 wd:${SWEDEN}. } UNION { ?perf wdt:P27 wd:${SWEDEN}. } UNION { ?perf wdt:P495 wd:${SWEDEN}. }` : ''}
  ?perf rdfs:label ?perfLabel. FILTER(LANG(?perfLabel) IN ("en", "sv"))
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,sv". }
} GROUP BY ?song ?songLabel ORDER BY DESC(?fame) LIMIT ${contest || !Number.isFinite(TOP) ? 5000 : Math.max(TOP * 3, 300)}`;
}

/** Items' entity data from the Wikidata API, 50 at a time. */
async function entities(ids: string[], props: string): Promise<Record<string, WikidataEntity>> {
  const out: Record<string, WikidataEntity> = {};
  for (let i = 0; i < ids.length; i += 50) {
    const url = `https://www.wikidata.org/w/api.php?${new URLSearchParams({ action: 'wbgetentities', ids: ids.slice(i, i + 50).join('|'), props, languages: 'sv|en', format: 'json' })}`;
    Object.assign(out, ((await (await fetch(url, { headers: agent })).json()) as { entities?: Record<string, WikidataEntity> }).entities);
    await sleep(200);
  }
  return out;
}

interface WikidataEntity {
  labels?: Record<string, { value: string }>;
  claims?: Record<string, { rank: string; mainsnak: { datavalue?: { value: { id?: string } | string } } }[]>;
}

/**
 * The song's original performer: the first performer statement (a preferred one if there is one),
 * not whichever cover artist SPARQL samples. Named by the English label, which is usually the stage
 * name (the Swedish one is often the full name: "Netta Barzilai" for Netta), else the Swedish one;
 * STAGE_NAMES covers the rest. Pseudonyms (P742) are no help: they hold nicknames and old names.
 */
async function firstPerformers(songIds: string[]): Promise<Map<string, string>> {
  const songs = await entities([...new Set(songIds)], 'claims');
  const first = new Map<string, string>();
  for (const [id, e] of Object.entries(songs)) {
    const claims = (e.claims?.P175 ?? []).filter((c) => c.rank !== 'deprecated' && typeof c.mainsnak.datavalue?.value === 'object');
    const pick = claims.find((c) => c.rank === 'preferred') ?? claims[0];
    if (pick) first.set(id, (pick.mainsnak.datavalue!.value as { id: string }).id);
  }
  const people = await entities([...new Set(first.values())], 'labels');
  const names = new Map<string, string>();
  for (const [song, perf] of first) {
    const name = people[perf]?.labels?.en?.value ?? people[perf]?.labels?.sv?.value;
    if (name) names.set(song, name);
  }
  return names;
}

/** Stage names for artists Wikidata names in full. */
const STAGE_NAMES: Record<string, string> = {
  'Carola Häggkvist': 'Carola',
  'Toussaint Chiza': 'Tusse',
  'Mariette Hansson': 'Mariette',
  'Amy Deasismont': 'Amy Diamond',
  'Netta Barzilai': 'Netta',
  'Chanel Terrero': 'Chanel',
  'Louane Emera': 'Louane',
  'Felicia Eriksson': 'Felicia',
  'Emilia Rydberg': 'Emilia',
  'Daði Freyr Pétursson': 'Daði Freyr',
};

/**
 * Melodifestivalen entries Wikidata doesn't link to their edition: the Swedish Wikipedia page for
 * each year lists the entries in tables, one row per song. Returns a check for a title and artist
 * standing in the same row (or list line) of any year's page.
 */
async function melodifestivalenPages(): Promise<(title: string, artist: string) => boolean> {
  const plain = (t: string) =>
    ` ${normalizeKey(t.replace(/\bi morgon\b/gi, 'imorgon')).replace(/\bmej\b/g, 'mig').replace(/\bdej\b/g, 'dig')} `;
  const strip = (t: string) =>
    t
      .replace(/\{\{[^{}]*\}\}/g, '')
      .replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1');
  const rows: string[] = [];
  for (let year = 1959; year <= new Date().getFullYear(); year++) {
    const url = `https://sv.wikipedia.org/w/api.php?${new URLSearchParams({ action: 'parse', page: `Melodifestivalen ${year}`, prop: 'wikitext', format: 'json', formatversion: '2', redirects: '1' })}`;
    const text = ((await (await fetch(url, { headers: agent })).json()) as { parse?: { wikitext?: string } }).parse?.wikitext ?? '';
    rows.push(...text.split(/\n\|-/).map((r) => plain(strip(r))), ...text.split('\n').filter((l) => /^[*#:]/.test(l)).map((l) => plain(strip(l))));
    await sleep(300);
  }
  return (title, artist) => {
    const t = plain(title);
    const a = plain(artist.split(/\s*(?:,|&|\boch\b)\s*/)[0]);
    return rows.some((r) => r.includes(t) && r.includes(a));
  };
}

async function songsFor(where: string, via: string, contest = false): Promise<Found[]> {
  let rows: Record<string, { value: string }>[];
  try {
    rows = await sparql(songQuery(where, true, contest));
  } catch (e) {
    console.log(`  ${via}: ${(e as Error).message} with sub-genres, trying the genres alone.`);
    rows = await sparql(songQuery(where, false, contest));
  }
  const original = await firstPerformers(rows.map((r) => r.song.value.split('/').pop()!));
  return rows
    .map((r) => ({
      // Wikidata labels may carry a disambiguation: "One Day (Mariette song)".
      title: (r.songLabel?.value ?? '').replace(/\s*\([^)]*\bsong\)$/i, ''),
      artist: ((a) => STAGE_NAMES[a] ?? a)(original.get(r.song.value.split('/').pop()!) ?? r.artist?.value ?? ''),
      year: Number(r.year?.value),
      fame: Number(r.fame?.value ?? 0),
      spotify: r.spotify?.value ?? null,
      via,
    }))
    .filter((s) => s.title && !/^Q\d+$/.test(s.title) && s.artist && s.year >= 1950 && s.year <= new Date().getFullYear());
}

async function main(): Promise<void> {
  const items: string[] = [];
  // Schlager means a song that took part in Melodifestivalen or Eurovision, nothing else (Markus, 2026-11-22).
  for (const label of GENRE === 'schlager' ? [] : WIKIDATA_GENRES[GENRE]) {
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
    // Every Melodifestivalen and Eurovision entry. Editions are in the contest's series (P179:
    // Melodifestivalen Q58884, Eurovision Song Contest Q276); a song "participated in" its edition
    // (P1344), and some winners are only linked from the edition (P1346).
    for (const [series, via] of [['Q58884', 'Melodifestivalen'], ['Q276', 'Eurovision']]) {
      const where = `?edition wdt:P179 wd:${series}. { ?song wdt:P1344 ?edition. } UNION { ?edition wdt:P1346 ?song. }`;
      const songs = await songsFor(where, via, true);
      console.log(`${via}: ${songs.length} entries`);
      found.push(...songs);
    }
  }

  // Wikidata often names artists in full ("Carola Häggkvist" for "Carola"), so a song matches
  // when the titles are the same and one artist name starts with the other.
  const index = (rows: { title: string; artist: string }[]) => {
    const byTitle = new Map<string, string[]>();
    for (const r of rows) {
      const [title, artist] = songKey(r.title, r.artist).split('|');
      byTitle.set(title, [...(byTitle.get(title) ?? []), artist]);
    }
    return {
      has: (key: string) => {
        const [title, artist] = key.split('|');
        return (byTitle.get(title) ?? []).some((a) => a === artist || a.startsWith(`${artist} `) || artist.startsWith(`${a} `));
      },
    };
  };
  const catalogue = index(JSON.parse(readFileSync(SONGS_FILE, 'utf8')) as { title: string; artist: string }[]);
  const candidates = JSON.parse(readFileSync(CANDIDATES_FILE, 'utf8')) as { title: string; artist: string; year: number; genres: string[] }[];
  const waiting = index(candidates);

  // One row per song, the best-known first; a song found both ways keeps both reasons. Contest
  // songs with the same title and year are one song: early Melodifestivalen had each song sung
  // by two artists, and a Melodifestivalen winner goes on to Eurovision. The same title by the same
  // artist is one song too, whatever the year (Wikidata may have an item per contest).
  const sameSong = (s: Found) => (s.via === 'genre' ? songKey(s.title, s.artist) : `${songKey(s.title, '').split('|')[0]}|${s.year}`);
  const byKey = new Map<string, Found>();
  const alias = new Map<string, string>();
  for (const s of [...found].sort((a, b) => b.fame - a.fame)) {
    const key = alias.get(songKey(s.title, s.artist)) ?? sameSong(s);
    const had = byKey.get(key);
    if (!had) byKey.set(key, s);
    else if (!had.via.includes(s.via)) had.via += `, ${s.via}`;
    alias.set(songKey(s.title, s.artist), key);
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

  // Schlager is contest songs only: other songs tagged schlager lose the tag. One with no other genre
  // is set aside in scripts/skipped.json (a candidate) or left without a genre (a catalogue song), never
  // moved to another genre by guess.
  const contestTitles = new Set(found.filter((s) => s.via !== 'genre').map((s) => songKey(s.title, '').split('|')[0]));
  const notContest = (r: { title: string; genres: string[] }) => GENRE === 'schlager' && r.genres.includes('schlager') && !contestTitles.has(songKey(r.title, '').split('|')[0]);
  const songs = JSON.parse(readFileSync(SONGS_FILE, 'utf8')) as { title: string; artist: string; genres: string[] }[];
  const untagged = [...songs, ...candidates].filter(notContest);
  // Wikidata misses many entries; the yearly Wikipedia pages catch some of them.
  const onPage = untagged.length ? await melodifestivalenPages() : () => false;
  const saved = untagged.filter((r) => onPage(r.title, r.artist));
  if (saved.length) {
    console.log(`\n${saved.length} songs tagged schlager were found on the Melodifestivalen pages of Swedish Wikipedia and keep it:`);
    for (const r of saved) console.log(`  ${r.title} – ${r.artist}`);
  }
  const retag = untagged.filter((r) => !saved.includes(r));
  if (retag.length) {
    console.log(`\n${retag.length} songs tagged schlager were not in Melodifestivalen or Eurovision${process.env.APPLY === '1' ? ' and lose the tag' : ' (APPLY=1 takes the tag away; one with no other genre is set aside)'}:`);
    for (const r of retag) console.log(`  ${r.title} – ${r.artist}`);
  }

  if (process.env.APPLY === '1') {
    for (const r of retag) r.genres = r.genres.filter((g) => g !== 'schlager');
    const skipped = candidates.filter((r) => retag.includes(r) && !r.genres.length);
    const keep = candidates.filter((r) => !skipped.includes(r));
    keep.push(...fresh.map((s) => ({ title: s.title, artist: s.artist, year: s.year, genres: [GENRE] })));
    const lines = (list: object[]) => '[\n' + list.map((r) => ' ' + JSON.stringify(r)).join(',\n') + '\n]\n';
    writeFileSync(CANDIDATES_FILE, lines(keep));
    if (skipped.length) {
      const before = existsSync(SKIPPED_FILE) ? (JSON.parse(readFileSync(SKIPPED_FILE, 'utf8')) as object[]) : [];
      writeFileSync(SKIPPED_FILE, lines([...before, ...skipped.map((r) => ({ ...r, genres: ['schlager'], why: 'not found in Melodifestivalen or Eurovision' }))]));
      console.log(`Set ${skipped.length} candidates aside in scripts/skipped.json.`);
    }
    if (retag.some((r) => songs.includes(r as never))) writeFileSync(SONGS_FILE, lines(songs));
    console.log(`Added ${fresh.length} songs to scripts/candidates.json.`);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
