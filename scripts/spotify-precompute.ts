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
 * It also gives every song its genres from MusicBrainz (no key needed) and,
 * when LASTFM_API_KEY is set, Last.fm: the tags people gave that recording,
 * mapped to the catalogue's genres (src/data/genreTags.ts). This costs no
 * Spotify requests. Tags only add genres to the hand-set ones; songs the sources know nothing about keep their hand-set
 * genres, as do film, TV, game and stage songs, and a song whose genres were changed by hand in songs.json is left
 * alone from then on.
 *
 * Put SPOTIFY_CLIENT_ID=… and SPOTIFY_CLIENT_SECRET=… in .env.local (never
 * committed), then `npm run spotify-data`. Environment variables work too.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BuiltInDeckId, CatalogRow } from '../src/data/catalog';
import { SEARCH_GENRE_DEFS as SEARCH_GENRES } from '../src/data/searchGenres';
import { genresFromTags, mergeGenres, type Tags } from '../src/data/genreTags';
import {
  cleanTitle,
  needsYearCheck,
  normalizeKey,
  releaseYear,
  songKey,
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
/** Songs to add: looked up here, and moved into songs.json only once they have a Spotify id. */
const CANDIDATES_FILE = file('./candidates.json');
const DECKS_FILE = file('../src/data/catalog/decks.json');
const REVIEW_FILE = file('../src/data/catalog/REVIEW.md');
const PROGRESS_FILE = file('./spotify-progress.json');
const GENRES_FILE = file('./genre-progress.json');

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
  /** Deck songs whose Spotify page names another artist (title|artist → id), for a look by hand. */
  suspect?: Record<string, string>;
  /** Wikidata ids checked against their Spotify page (title|artist → when). */
  audited?: Record<string, string>;
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

/** A catalogue row, or a candidate (id null) that hasn't been found yet. */
type Row = Omit<CatalogRow, 'id'> & { id: string | null };
const catalogue = readJson<CatalogRow[]>(SONGS_FILE, []);
const known = new Set(catalogue.map((r) => songKey(r.title, r.artist)));
const rows: Row[] = [
  ...catalogue,
  // Candidates already in the catalogue are dropped.
  ...readJson<Row[]>(CANDIDATES_FILE, [])
    .filter((r) => !known.has(songKey(r.title, r.artist)))
    .map((r) => ({ ...r, id: null })),
];
const decks = readJson<Record<BuiltInDeckId, string[]>>(DECKS_FILE, {} as Record<BuiltInDeckId, string[]>);
const progress = readJson<Progress>(PROGRESS_FILE, { tried: {} });
progress.unmatched ??= {};
progress.yearNotes ??= {};
progress.wikidata ??= {};
progress.rechecked ??= {};

/** What MusicBrainz and Last.fm said about a song, and the genres it had before. */
interface GenreEntry {
  /** The song's genres before any tags were used. */
  handSet: string[];
  /** The genres last written to songs.json; a different value there means someone changed them by hand. */
  applied?: string[];
  /** Changed by hand: left alone. */
  manual?: boolean;
  mb?: Tags;
  mbAt?: string;
  lastfm?: Tags;
  lastfmAt?: string;
}
const genreData = readJson<Record<string, GenreEntry>>(GENRES_FILE, {});

const keyOf = (r: Pick<Row, 'title' | 'artist'>) => `${r.title}|${r.artist}`;
const sortKeys = <T,>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const today = () => new Date().toISOString().slice(0, 10);

/** Which ready-made deck a song is in, for messages. */
function deckOf(row: Row): string {
  const deck = row.id ? Object.entries(decks).find(([, ids]) => ids.includes(row.id!)) : undefined;
  return deck ? deck[0] : 'catalogue';
}

/** Gives a song a new id, also in the decks that list it. */
function setId(row: Row, id: string): void {
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
  // Only songs with a Spotify id go in the catalogue; the rest wait in candidates.json.
  const lines = (list: Row[]) => '[\n' + list.map((r) => ' ' + JSON.stringify(r)).join(',\n') + '\n]\n';
  writeFileSync(SONGS_FILE, lines(rows.filter((r) => r.id)));
  writeFileSync(CANDIDATES_FILE, lines(rows.filter((r) => !r.id).map(({ id: _id, ...r }) => r as Row)));
  writeFileSync(
    DECKS_FILE,
    '{\n' +
      Object.entries(decks)
        .map(([d, ids]) => ` ${JSON.stringify(d)}: [\n${ids.map((id) => '  ' + JSON.stringify(id)).join(',\n')}\n ]`)
        .join(',\n') +
      '\n}\n',
  );
  writeFileSync(
    GENRES_FILE,
    '{\n' + Object.entries(sortKeys(genreData)).map(([k, e]) => ` ${JSON.stringify(k)}: ${JSON.stringify(e)}`).join(',\n') + '\n}\n',
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
export function bestMatch(song: Pick<Row, 'title' | 'artist' | 'year'>, items: SpotifyTrack[]): { track: SpotifyTrack & { id: string }; earliest: number | null } | null {
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
/**
 * Whether the track's public Spotify page (not part of the API quota) names
 * the song's artist; null when the page can't tell.
 */
async function pageArtist(id: string, row: Row): Promise<boolean | null> {
  try {
    if (!process.env.NO_SLEEP) await sleep(300);
    const res = await fetch(`https://open.spotify.com/track/${id}`, { headers: { 'User-Agent': 'the-musicquiz-precompute/1.0 (https://github.com/Dybecks/the-musicquiz)' } });
    if (!res.ok) return null;
    const html = await res.text();
    const meta = (p: string) => html.match(new RegExp(`<meta[^>]+property="${p}"[^>]+content="([^"]*)"`))?.[1] ?? '';
    const text = normalizeKey(`${meta('og:description')} ${meta('og:title')} ${(html.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? ''}`);
    if (!text) return null;
    return artistParts(row.artist).some((a) => text.includes(a));
  } catch {
    return null;
  }
}

/** Takes an id away from a song (and from the decks): it goes back to the candidates to be searched. */
function dropId(row: Row, why: string): void {
  console.log(`✗ ${row.title} – ${row.artist}: ${row.id} dropped (${why})`);
  for (const [deck, list] of Object.entries(decks)) {
    const i = row.id ? list.indexOf(row.id) : -1;
    if (i >= 0) {
      list.splice(i, 1);
      console.log(`  also taken out of the ${deck} deck`);
    }
  }
  row.id = null;
}

/**
 * Ids taken from Wikidata were only checked by title, so some belong to
 * another artist's song of the same name. Each one is checked once against
 * its Spotify page (free); a wrong one, or one two songs share, is dropped and
 * the song is searched again.
 */
async function auditIds(): Promise<void> {
  progress.audited ??= {};
  progress.suspect ??= {};
  const byId = new Map<string, Row[]>();
  for (const r of rows) if (r.id) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  for (const r of rows) {
    const key = keyOf(r);
    if (!r.id) continue;
    const shared = (byId.get(r.id) ?? []).length > 1;
    const fromWikidata = progress.wikidata![key] && !progress.tried[key];
    if (!shared && (!fromWikidata || progress.audited[key])) continue;
    const ok = await pageArtist(r.id, r);
    progress.audited[key] = today();
    if (ok !== false) continue;
    // A deck song is only flagged (in REVIEW.md), never dropped by this check alone.
    if (!shared && Object.values(decks).some((ids) => ids.includes(r.id!))) progress.suspect![key] = r.id;
    else dropId(r, "its Spotify page names another artist");
  }
  // Still shared (the page couldn't tell): keep the first, search the others.
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.id) continue;
    if (seen.has(r.id)) dropId(r, 'another song has this id');
    else seen.add(r.id);
  }
  save();
}

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
    let bindings: { label: { value: string }; sp: { value: string }; performerLabel?: { value: string } }[] = [];
    try {
      const res = await fetch(`https://query.wikidata.org/sparql?${new URLSearchParams({ query, format: 'json' })}`, {
        headers: { ...agent, Accept: 'application/sparql-results+json' },
      });
      if (!res.ok) throw new Error(`Wikidata answered ${res.status}`);
      bindings = ((await res.json()) as { results: { bindings: typeof bindings } }).results.bindings;
    } catch (e) {
      console.log(`Wikidata not available (${(e as Error).message}); searching Spotify instead.`);
      return;
    }
    for (const song of chunk) {
      const key = keyOf(song);
      const candidates = [
        ...new Set(
          bindings
            .filter((r) => r.label.value === song.title)
            // The performer must be known and match: a title alone matched other songs (Creep by TLC got Radiohead's).
            .filter((r) => r.performerLabel && sameArtist({ artists: [{ id: '', name: r.performerLabel.value }] } as SpotifyTrack, song.artist))
            .map((r) => r.sp.value)
            .filter((id) => /^[0-9A-Za-z]{22}$/.test(id) && !rows.some((o) => o !== song && o.id === id)),
        ),
      ];
      for (const id of candidates) {
        if (!process.env.NO_SLEEP) await sleep(300);
        try {
          const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${id}`)}`, { headers: agent });
          if (!res.ok) continue;
          const { title } = (await res.json()) as { title?: string };
          if (title && normalizeKey(cleanTitle(title)) === normalizeKey(cleanTitle(song.title)) && (await pageArtist(id, song)) !== false) {
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

/**
 * Deck songs whose Spotify page names another artist are searched once on
 * Spotify; a match by the right artist replaces the id, in the decks too.
 */
async function fixSuspects(): Promise<void> {
  for (const [key, id] of Object.entries(progress.suspect ?? {})) {
    const song = rows.find((r) => keyOf(r) === key);
    if (!song || song.id !== id) {
      delete progress.suspect![key];
      continue;
    }
    const firstArtist = song.artist.split(/\s*(?:,|&|feat\.|ft\.)\s*/i)[0];
    const found = bestMatch(song, (await search(`track:"${quoteless(song.title)}" artist:"${quoteless(firstArtist)}"`)).items);
    progress.tried[key] = today();
    if (found && found.track.id !== id && !rows.some((o) => o !== song && o.id === found.track.id)) {
      console.log(`↻ ${song.title} – ${song.artist}: ${id} → ${found.track.id} (the old id was another artist's)`);
      setId(song, found.track.id);
      delete progress.suspect![key];
    } else if (found?.track.id === id) {
      delete progress.suspect![key]; // Spotify's own search agrees: the page check was wrong
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

// ---- Genres (MusicBrainz, Last.fm) ----

const ORDER = SEARCH_GENRES.map((g) => g.id);
const AGENT = { 'User-Agent': 'the-musicquiz-precompute/1.0 ( https://github.com/Dybecks/the-musicquiz )' };
const lucene = (t: string) => `"${t.replace(/[\\"]/g, '\\$&')}"`;
const sameList = (a: readonly string[] = [], b: readonly string[] = []) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A JSON GET that waits and retries when the service is busy. */
async function getJson<T>(url: string, pause: number): Promise<T | null> {
  let wait = pause;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (!process.env.NO_SLEEP) await sleep(wait);
    let res: Response;
    try {
      res = await fetch(url, { headers: { ...AGENT, Accept: 'application/json' } });
    } catch {
      wait = Math.min(30_000, wait * 2);
      continue;
    }
    if (res.ok) return (await res.json()) as T;
    if (res.status === 404) return null;
    if (res.status !== 503 && res.status !== 429 && res.status < 500) throw new Error(`${new URL(url).host} answered ${res.status}`);
    // Busy (MusicBrainz allows about one request a second): wait longer each time, up to 30 s.
    const asked = Number(res.headers.get('retry-after')) * 1000;
    wait = Math.min(30_000, Math.max(asked || 0, wait * 2));
  }
  throw new Error(`${new URL(url).host} is busy`);
}

interface MbRecording {
  title: string;
  score?: number;
  'artist-credit'?: { name: string; artist?: { name: string } }[];
  tags?: { name: string; count: number }[];
  releases?: { 'release-group'?: { id: string; 'primary-type'?: string; 'secondary-types'?: string[] } }[];
}

/** Tags on MusicBrainz for every recording of the song; the release group's genres when the recordings have none. */
async function musicBrainzTags(row: Row): Promise<Tags> {
  const firstArtist = row.artist.split(/\s*(?:,|&|feat\.|ft\.)\s*/i)[0];
  const query = `recording:${lucene(row.title)} AND artist:${lucene(firstArtist)}`;
  const body = await getJson<{ recordings?: MbRecording[] }>(
    `https://musicbrainz.org/ws/2/recording?${new URLSearchParams({ query, fmt: 'json', limit: '25' })}`,
    1500,
  );
  const want = normalizeKey(cleanTitle(row.title));
  const recordings = (body?.recordings ?? []).filter(
    (r) =>
      (r.score ?? 0) >= 80 &&
      normalizeKey(cleanTitle(r.title)) === want &&
      sameArtist({ artists: (r['artist-credit'] ?? []).map((a) => ({ id: '', name: a.artist?.name ?? a.name })) } as SpotifyTrack, row.artist),
  );
  const tags = new Map<string, number>();
  for (const r of recordings) for (const t of r.tags ?? []) tags.set(t.name, (tags.get(t.name) ?? 0) + Math.max(1, t.count));
  if (tags.size > 0 || recordings.length === 0) return [...tags];
  // No tags on the recordings: the single's or album's genres.
  const groups = new Map<string, number>();
  for (const r of recordings)
    for (const rel of r.releases ?? []) {
      const g = rel['release-group'];
      if (g && (g['primary-type'] === 'Single' || g['primary-type'] === 'Album') && !g['secondary-types']?.length) groups.set(g.id, (groups.get(g.id) ?? 0) + 1);
    }
  const group = [...groups].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!group) return [];
  const rg = await getJson<{ genres?: { name: string; count: number }[] }>(`https://musicbrainz.org/ws/2/release-group/${group}?inc=genres&fmt=json`, 1500);
  return (rg?.genres ?? []).map((g) => [g.name, Math.max(1, g.count)]);
}

/** Last.fm's top tags for the song (weights 0–100). */
async function lastFmTags(row: Row, key: string): Promise<Tags> {
  const params = new URLSearchParams({ method: 'track.gettoptags', artist: row.artist.split(/\s*(?:,|&|feat\.|ft\.)\s*/i)[0], track: row.title, autocorrect: '1', api_key: key, format: 'json' });
  const body = await getJson<{ toptags?: { tag?: { name: string; count: number }[] } }>(`https://ws.audioscrobbler.com/2.0/?${params}`, 250);
  return (body?.toptags?.tag ?? []).slice(0, 15).map((t) => [t.name, Number(t.count) || 0]);
}

/** Sets each song's genres from the tags; looks up songs not asked yet. */
async function fillGenres(): Promise<void> {
  const lastFmKey = process.env.LASTFM_API_KEY;
  let asked = 0;
  let failures = 0;
  for (const row of rows) {
    if (!row.id) continue; // a candidate not found yet
    const key = keyOf(row);
    const entry = (genreData[key] ??= { handSet: [...row.genres] });
    if (entry.applied && !sameList(entry.applied, row.genres)) entry.manual = true;
    if (entry.manual) continue;
    try {
      if (!entry.mbAt) {
        entry.mb = await musicBrainzTags(row);
        entry.mbAt = today();
        asked++;
      }
      if (lastFmKey && !entry.lastfmAt) {
        entry.lastfm = await lastFmTags(row, lastFmKey);
        entry.lastfmAt = today();
        asked++;
      }
      failures = 0;
    } catch (e) {
      // One song failing doesn't stop the run; many in a row do.
      console.log(`Genre lookup for ${row.title} – ${row.artist} failed (${(e as Error).message}); trying it next run.`);
      if (++failures >= 5) {
        console.log('Genre lookup stopped after 5 failures in a row; the next run carries on.');
        save();
        return;
      }
      continue;
    }
    // Film, TV, game and stage songs keep their hand-set genres: score tags ("soundtrack", "ambient") say little.
    const genres = row.from ? [...entry.handSet] : mergeGenres(entry.handSet, genresFromTags(entry.mb ?? [], entry.lastfm ?? []), ORDER);
    if (!sameList(genres, row.genres)) console.log(`♪ ${row.title} – ${row.artist}: ${row.genres.join(', ') || '–'} → ${genres.join(', ') || '–'}`);
    row.genres = genres;
    entry.applied = genres;
    if (asked && asked % 20 === 0) save();
  }
  save();
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
    '## Deck songs that may have the wrong recording',
    '',
    "Their Spotify page names another artist. Check the id by hand (open.spotify.com/track/<id>).",
    '',
    ...(Object.entries(progress.suspect ?? {}).filter(([k, id]) => byKey.get(k)?.id === id).map(([k, id]) => `- ${k.replace('|', ' – ')}: ${id}`) || []),
    '',
    '## Year differs from Spotify',
    '',
    'The catalogue year was kept. Spotify is often wrong (it dates songs by album), but these are worth a check.',
    '',
    ...(years.length ? years.map(item) : ['None.']),
    '',
    '## Songs per genre ("By genre")',
    '',
    (() => {
      const entries = rows.map((r) => genreData[keyOf(r)]);
      const tagged = entries.filter((e) => e && !e.manual && genresFromTags(e.mb ?? [], e.lastfm ?? []).length).length;
      const manual = entries.filter((e) => e?.manual).length;
      return `Genres from MusicBrainz/Last.fm tags: ${tagged} songs; hand-set: ${rows.length - tagged - manual}; changed by hand: ${manual}.`;
    })(),
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
    await auditIds();
    await fromWikidata();
    await fixSuspects();
    await fillIds();
    await recheckOddYears();
  } catch (e) {
    if (!(e instanceof StopRun)) {
      save();
      throw e;
    }
    stopped = e.message;
    console.log(`\nSpotify stopped the run: ${stopped} (${requests} requests). Genres are looked up next.`);
  }
  // Genres cost no Spotify requests, so they are looked up even when Spotify stopped the run.
  if (process.env.GENRES !== '0') await fillGenres();
  save();
  console.log(`\n${requests} requests. ${stopped ? `Stopped early: ${stopped} The next run carries on.` : 'All done.'}`);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
