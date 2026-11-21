/**
 * Fills in the Spotify track ids in the song catalogue
 * (src/data/catalog/songs.json), so the game can play every song without
 * asking Spotify anything at game time. Rows with "id": null are looked up:
 * first on Wikidata (free, checked with Spotify's oEmbed), then with at most
 * two Spotify searches each. Songs Spotify doesn't have are taken out of the
 * catalogue and listed in src/data/catalog/REVIEW.md, never guessed.
 *
 * Run locally with the app's Client ID and Secret (Client Credentials flow,
 * no user login). Spotify's request quota is shared by every app on the
 * developer account, so the script is slow on purpose, stops after
 * MAX_REQUESTS, and stops early if Spotify asks for a long pause. Everything
 * it learns is saved as it goes, and the next run carries on where this one
 * stopped.
 *
 * Put SPOTIFY_CLIENT_ID=… and SPOTIFY_CLIENT_SECRET=… in .env.local (never
 * committed), then `npm run spotify-data`. Environment variables work too.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BuiltInDeckId, CatalogRow } from '../src/data/catalog';
import { SEARCH_GENRE_DEFS as SEARCH_GENRES } from '../src/data/searchGenres';
import {
  cleanTitle,
  needsYearCheck,
  normalizeKey,
  releaseYear,
  type SpotifyTrack,
} from '../src/spotify/personalDeck';

const file = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Values from .env.local (KEY=value lines), unless already set.
try {
  for (const line of readFileSync(file('../.env.local'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {
  /* no .env.local */
}
const SONGS_FILE = file('../src/data/catalog/songs.json');
const DECKS_FILE = file('../src/data/catalog/decks.json');
const REVIEW_FILE = file('../src/data/catalog/REVIEW.md');
const PROGRESS_FILE = file('./spotify-progress.json');

/** Requests per run. The next run carries on. */
const MAX_REQUESTS = Number(process.env.MAX_REQUESTS || 300);
/** Time between requests. */
const PAUSE_MS = Number(process.env.PAUSE_MS || 1500);
/** A pause Spotify asks for that is longer than this ends the run instead. */
const LONGEST_WAIT_S = 120;
/** Songs are tied to this market, so they play in Sweden. */
const MARKET = process.env.SPOTIFY_MARKET || 'SE';
/** Decades shown in the review's genre table. */
const DECADES = [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020];

// Versions of a song that aren't the song as people know it.
const NOT_ORIGINAL = /\b(karaoke|instrumental|tribute|cover|remix|re-?mix|acoustic|sped up|slowed|8-?bit|lullaby|piano version|made famous|in the style of)\b|\(live\b|\s-\s.*\blive\b|\blive (at|from|in)\b/i;

// ---- Files ----

interface Progress {
  /** Songs already searched for on Spotify (title|artist → when). */
  tried: Record<string, string>;
  /** Songs searched again with the closest-year rule (title|artist → when). */
  rechecked?: Record<string, string>;
  /** Songs already looked up on Wikidata (title|artist → when). */
  wikidata?: Record<string, string>;
  /** Songs that matched nothing and were taken out of the catalogue, with why. */
  unmatched?: Record<string, string>;
  /** Songs whose Spotify year differs from the catalogue's year. */
  yearNotes?: Record<string, string>;
}

const readJson = <T,>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

const rows = readJson<CatalogRow[]>(SONGS_FILE, []);
const decks = readJson<Record<BuiltInDeckId, string[]>>(DECKS_FILE, {} as Record<BuiltInDeckId, string[]>);
const progress = readJson<Progress>(PROGRESS_FILE, { tried: {} });
progress.unmatched ??= {};
progress.yearNotes ??= {};
progress.wikidata ??= {};
progress.rechecked ??= {};

const keyOf = (r: Pick<CatalogRow, 'title' | 'artist'>) => `${r.title}|${r.artist}`;
const sortKeys = <T,>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const today = () => new Date().toISOString().slice(0, 10);

/** Which ready-made deck a song is in, for messages. */
function deckOf(row: CatalogRow): string {
  const deck = row.id ? Object.entries(decks).find(([, ids]) => ids.includes(row.id!)) : undefined;
  return deck ? deck[0] : 'catalogue';
}

/** Gives a song a new id, also in the decks that list it. */
function setId(row: CatalogRow, id: string): void {
  for (const list of Object.values(decks)) {
    const i = row.id ? list.indexOf(row.id) : -1;
    if (i >= 0) list[i] = id;
  }
  row.id = id;
  delete progress.unmatched![keyOf(row)];
}

function save(): void {
  rows.sort((a, b) => a.year - b.year || a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
  // One song per line keeps the diffs readable.
  writeFileSync(SONGS_FILE, '[\n' + rows.map((r) => ' ' + JSON.stringify(r)).join(',\n') + '\n]\n');
  writeFileSync(
    DECKS_FILE,
    '{\n' +
      Object.entries(decks)
        .map(([d, ids]) => ` ${JSON.stringify(d)}: [\n${ids.map((id) => '  ' + JSON.stringify(id)).join(',\n')}\n ]`)
        .join(',\n') +
      '\n}\n',
  );
  writeFileSync(PROGRESS_FILE, JSON.stringify({ ...progress, tried: sortKeys(progress.tried) }, null, 1) + '\n');
  writeFileSync(REVIEW_FILE, review());
}

// ---- Spotify ----

class StopRun extends Error {}

let token = '';
let tokenExpires = 0;
let requests = 0;
let searchLimit = 50;

async function getToken(): Promise<string> {
  if (token && Date.now() < tokenExpires - 60_000) return token;
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Spotify refused the Client ID or Secret (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  token = body.access_token;
  tokenExpires = Date.now() + body.expires_in * 1000;
  return token;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class BadRequest extends Error {}

async function spotify<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (requests >= MAX_REQUESTS) throw new StopRun(`Reached ${MAX_REQUESTS} requests for this run.`);
    if (requests > 0) await sleep(PAUSE_MS);
    requests++;
    const res = await fetch(`https://api.spotify.com/v1${path}`, { headers: { Authorization: `Bearer ${await getToken()}` } });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 30;
      const text = await res.text();
      if (wait > LONGEST_WAIT_S || attempt >= 3) throw new StopRun(`Spotify asked for a pause of ${wait} s (${text.slice(0, 200)}).`);
      console.log(`Spotify asked for a pause of ${wait} s; waiting.`);
      await sleep(wait * 1000);
      continue;
    }
    if (res.status === 401) {
      token = '';
      if (attempt < 2) continue;
    }
    if (res.status === 400) throw new BadRequest(await res.text());
    if (res.status >= 500 && attempt < 3) {
      await sleep(5000);
      continue;
    }
    throw new Error(`Spotify answered ${res.status} for ${path}: ${(await res.text()).slice(0, 300)}`);
  }
}

async function search(q: string, offset = 0): Promise<{ items: SpotifyTrack[]; total: number }> {
  const run = async () => {
    const params = new URLSearchParams({ q, type: 'track', market: MARKET, limit: String(searchLimit), offset: String(offset) });
    const body = await spotify<{ tracks?: { items: (SpotifyTrack | null)[]; total?: number } }>(`/search?${params}`);
    return { items: (body.tracks?.items ?? []).filter((t): t is SpotifyTrack => !!t), total: body.tracks?.total ?? 0 };
  };
  try {
    return await run();
  } catch (e) {
    // Development Mode apps may get fewer results per search.
    if (e instanceof BadRequest && searchLimit > 10) {
      searchLimit = 10;
      console.log('Search results are capped at 10 for this app.');
      return run();
    }
    throw e;
  }
}

// ---- Matching ----

const quoteless = (s: string) => s.replace(/["]/g, '');
const artistParts = (artist: string) =>
  [artist, ...artist.split(/\s*(?:,|&|\band\b|feat\.|ft\.|featuring|\/)\s*/i)].map(normalizeKey).filter((a) => a.length > 1);

/** Whether a track is by the song's artist: the whole name, or any of the names in it. */
function sameArtist(track: SpotifyTrack, artist: string): boolean {
  const wanted = artistParts(artist);
  return track.artists.some((a) => {
    const name = normalizeKey(a.name);
    return wanted.some((w) => name === w || (w.length > 3 && (name.includes(w) || w.includes(name))));
  });
}

function sameTitle(track: SpotifyTrack, title: string): boolean {
  const t = normalizeKey(cleanTitle(track.name));
  const want = normalizeKey(cleanTitle(title));
  return t === want || normalizeKey(track.name) === normalizeKey(title);
}

/**
 * The best match among search results: same title and artist, not a karaoke
 * or live version, preferring the original album or single over reissues,
 * then the earliest release.
 */
export function bestMatch(song: Pick<CatalogRow, 'title' | 'artist' | 'year'>, items: SpotifyTrack[]): { track: SpotifyTrack & { id: string }; earliest: number | null } | null {
  const ok = uniqueTracksKeepAll(items).filter(
    (t) => sameTitle(t, song.title) && sameArtist(t, song.artist) && (NOT_ORIGINAL.test(song.title) || !NOT_ORIGINAL.test(`${t.name} ${t.album.name ?? ''}`)),
  );
  if (ok.length === 0) return null;
  const years = ok.map((t) => releaseYear(t.album.release_date)).filter((y): y is number => y !== null);
  const earliest = years.length ? Math.min(...years) : null;
  // The original album or single first; then the release closest to the
  // song's known year. A release dated before the song is broken metadata
  // (Spotify has "1932" compilations of 1970s musicals), so it counts as far.
  const rank = (t: SpotifyTrack) => (needsYearCheck(t) ? 1 : 0);
  const distance = (t: SpotifyTrack) => {
    const y = releaseYear(t.album.release_date);
    if (y === null) return 500;
    return y < song.year - 1 ? 200 + (song.year - y) : Math.abs(y - song.year);
  };
  const sorted = ok
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || distance(a.t) - distance(b.t) || a.i - b.i);
  return { track: sorted[0].t, earliest };
}

/** Like uniqueTracks, but keeps every release of a song (only drops local files and repeats of an id). */
function uniqueTracksKeepAll(items: SpotifyTrack[]): (SpotifyTrack & { id: string })[] {
  const seen = new Set<string>();
  return items.filter((t): t is SpotifyTrack & { id: string } => {
    if (!t.id || t.is_local || !t.artists?.length || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

/**
 * Free of Spotify API requests: Wikidata lists Spotify track ids for many
 * songs (property P2207). Each one is checked against Spotify's public oEmbed
 * endpoint (not part of the API quota): the id must exist and have the
 * song's title. Only songs left over after this are searched on Spotify.
 */
async function fromWikidata(): Promise<void> {
  const todo = rows.filter((r) => !r.id && !progress.tried[keyOf(r)] && !progress.wikidata![keyOf(r)]);
  if (todo.length === 0) return;
  const agent = { 'User-Agent': 'the-musicquiz-precompute/1.0 (https://github.com/Dybecks/the-musicquiz)' };
  const literal = (t: string) => JSON.stringify(t) + '@en';
  for (let i = 0; i < todo.length; i += 40) {
    const chunk = todo.slice(i, i + 40);
    const titles = [...new Set(chunk.map((s) => s.title))];
    const query = `SELECT ?label ?sp ?performerLabel WHERE {
      VALUES ?label { ${titles.map(literal).join(' ')} }
      ?item rdfs:label ?label; wdt:P2207 ?sp.
      OPTIONAL { ?item wdt:P175 ?performer. ?performer rdfs:label ?performerLabel. FILTER(LANG(?performerLabel) = "en") }
    }`;
    let rows: { label: { value: string }; sp: { value: string }; performerLabel?: { value: string } }[] = [];
    try {
      const res = await fetch(`https://query.wikidata.org/sparql?${new URLSearchParams({ query, format: 'json' })}`, {
        headers: { ...agent, Accept: 'application/sparql-results+json' },
      });
      if (!res.ok) throw new Error(`Wikidata answered ${res.status}`);
      rows = ((await res.json()) as { results: { bindings: typeof rows } }).results.bindings;
    } catch (e) {
      console.log(`Wikidata not available (${(e as Error).message}); searching Spotify instead.`);
      return;
    }
    for (const song of chunk) {
      const key = keyOf(song);
      const candidates = [
        ...new Set(
          rows
            .filter((r) => r.label.value === song.title)
            .filter((r) => !r.performerLabel || sameArtist({ artists: [{ id: '', name: r.performerLabel.value }] } as SpotifyTrack, song.artist))
            .map((r) => r.sp.value)
            .filter((id) => /^[0-9A-Za-z]{22}$/.test(id)),
        ),
      ];
      for (const id of candidates) {
        if (!process.env.NO_SLEEP) await sleep(300);
        try {
          const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${id}`)}`, { headers: agent });
          if (!res.ok) continue;
          const { title } = (await res.json()) as { title?: string };
          if (title && normalizeKey(cleanTitle(title)) === normalizeKey(cleanTitle(song.title))) {
            setId(song, id);
            console.log(`✓ ${song.title} – ${song.artist}: ${id} (Wikidata)`);
            break;
          }
        } catch {
          /* try the next id, or search later */
        }
      }
      progress.wikidata![key] = today();
    }
    save();
  }
}

async function fillIds(): Promise<void> {
  for (const song of [...rows]) {
    const key = keyOf(song);
    if (song.id || progress.tried[key]) continue;
    const firstArtist = song.artist.split(/\s*(?:,|&|feat\.|ft\.)\s*/i)[0];
    // At most two searches: the exact one, then a looser one.
    const queries = [`track:"${quoteless(song.title)}" artist:"${quoteless(firstArtist)}"`, `${quoteless(song.title)} ${quoteless(firstArtist)}`];
    let found: ReturnType<typeof bestMatch> = null;
    for (const q of queries) {
      found = bestMatch(song, (await search(q)).items);
      if (found) break;
    }
    progress.tried[key] = today();
    if (found) {
      setId(song, found.track.id);
      if (found.earliest !== null && Math.abs(found.earliest - song.year) > 1) {
        progress.yearNotes![key] = `the catalogue says ${song.year}, Spotify's earliest release is ${found.earliest} (${found.track.album.name}).`;
      }
      console.log(`✓ ${song.title} – ${song.artist}: ${found.track.id}`);
    } else {
      // Not on Spotify: out of the catalogue, listed in the review.
      progress.unmatched![key] = `${song.year}, ${song.genres.join(', ') || 'no genre'}: no recording with this title by this artist.`;
      rows.splice(rows.indexOf(song), 1);
      console.log(`✗ ${song.title} – ${song.artist}: no match, taken out`);
    }
    save();
  }
}

/**
 * The first run picked the earliest release, which for some songs was a
 * compilation with a broken date. Songs whose Spotify year looked odd are
 * searched once more and get the release closest to their known year.
 */
async function recheckOddYears(): Promise<void> {
  const byKey = new Map(rows.map((r) => [keyOf(r), r]));
  for (const key of Object.keys(progress.yearNotes ?? {})) {
    const song = byKey.get(key);
    if (!song?.id || progress.rechecked![key]) continue;
    const firstArtist = song.artist.split(/\s*(?:,|&|feat\.|ft\.)\s*/i)[0];
    const found = bestMatch(song, (await search(`track:"${quoteless(song.title)}" artist:"${quoteless(firstArtist)}"`)).items);
    progress.rechecked![key] = today();
    if (found) {
      const year = releaseYear(found.track.album.release_date);
      if (found.track.id !== song.id) console.log(`↻ ${song.title} – ${song.artist}: ${song.id} → ${found.track.id} (${found.track.album.name}, ${year})`);
      setId(song, found.track.id);
      if (year !== null && Math.abs(year - song.year) > 1) {
        progress.yearNotes![key] = `the catalogue says ${song.year}; the recording used is from ${year} (${found.track.album.name}).`;
      } else delete progress.yearNotes![key];
    }
    save();
  }
}

// ---- Report ----

function review(): string {
  const byKey = new Map(rows.map((r) => [keyOf(r), r]));
  const unmatched = Object.entries(progress.unmatched ?? {}).filter(([k]) => !byKey.get(k)?.id);
  const years = Object.entries(progress.yearNotes ?? {}).filter(([k]) => byKey.get(k)?.id);
  const missing = rows.filter((r) => !r.id);
  const item = ([k, why]: [string, string]) => {
    const row = byKey.get(k);
    return `- ${k.replace('|', ' – ')}${row ? ` (${deckOf(row)})` : ''}: ${why}`;
  };
  const playable = rows.filter((r) => r.id);
  const lines = [
    '# Song catalogue: needs a look',
    '',
    'Written by `scripts/spotify-precompute.ts` from `songs.json` and `decks.json`.',
    '',
    `Songs with a Spotify id: **${playable.length} of ${rows.length}**. ` +
      Object.entries(decks).map(([d, ids]) => `${d} ${ids.length}`).join(', ') + '.',
    '',
    '## Not looked up yet',
    '',
    'These stay out of the game until `npm run spotify-data` finds them.',
    '',
    ...(missing.length ? missing.map((r) => `- ${r.title} – ${r.artist}`) : ['None.']),
    '',
    '## Not found on Spotify',
    '',
    'Taken out of the catalogue. Add one back with the right title and artist (and "id": null) to try again.',
    '',
    ...(unmatched.length ? unmatched.map(item) : ['None.']),
    '',
    '## Year differs from Spotify',
    '',
    'The catalogue year was kept. Spotify is often wrong (it dates songs by album), but these are worth a check.',
    '',
    ...(years.length ? years.map(item) : ['None.']),
    '',
    '## Songs per genre ("By genre")',
    '',
    `| Genre | ${DECADES.map((d) => `${String(d).slice(2)}s`).join(' | ')} | Total |`,
    `|---|${DECADES.map(() => '---:').join('|')}|---:|`,
    ...SEARCH_GENRES.map((g) => {
      const songs = playable.filter((r) => r.genres.includes(g.id));
      const counts = DECADES.map((d) => songs.filter((r) => r.year >= d && r.year <= d + 9).length);
      return `| ${g.id} | ${counts.join(' | ')} | ${songs.length} |`;
    }),
    '',
  ];
  return lines.join('\n');
}

// ---- Run ----

async function main(): Promise<void> {
  let stopped: string | null = null;
  try {
    await fromWikidata();
    await fillIds();
    await recheckOddYears();
  } catch (e) {
    if (!(e instanceof StopRun)) {
      save();
      throw e;
    }
    stopped = e.message;
  }
  save();
  console.log(`\n${requests} requests. ${stopped ? `Stopped early: ${stopped} The next run carries on.` : 'All done.'}`);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
