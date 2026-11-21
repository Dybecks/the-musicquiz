/**
 * Fills in Spotify data the game ships with, so it can play songs without
 * asking Spotify anything at game time:
 *
 *  1. A Spotify track id for every song in the ready-made decks that has none.
 *  2. The "By genre" lists: the hand-picked songs in scripts/genre-songs.ts,
 *     with their year and track id (songs also in a deck reuse its id).
 *
 * Run locally with the app's Client ID and Secret (Client Credentials flow,
 * no user login). Spotify's request quota is
 * shared by every app on the developer account, so the script is slow on
 * purpose, stops after MAX_REQUESTS, and stops early if Spotify asks for a
 * long pause. Everything it learns is saved as it goes, and the next run
 * carries on where this one stopped.
 *
 * Songs it can't match are listed in src/data/spotify/REVIEW.md, never guessed.
 *
 * Locally: put SPOTIFY_CLIENT_ID=… and SPOTIFY_CLIENT_SECRET=… in .env.local
 * (never committed), then `npm run spotify-data`. Environment variables work too.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Song } from '../src/game/engine';
import { DEFAULT_SONGS } from '../src/data/songs';
import { GAME_SONGS, MOVIE_SONGS, MUSICAL_SONGS, TV_SONGS } from '../src/data/soundtracks';
import { premadeKey, type GenrePools, type PoolRow } from '../src/data/spotifyData';
import { SEARCH_GENRE_DEFS as SEARCH_GENRES } from '../src/data/searchGenres';
import { GENRE_SONGS } from './genre-songs';
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
const IDS_FILE = file('../src/data/spotify/track-ids.json');
const POOLS_FILE = file('../src/data/spotify/genre-pools.json');
const REVIEW_FILE = file('../src/data/spotify/REVIEW.md');
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
  /** Ready-made songs already searched for (key → when). */
  tried: Record<string, string>;
  /** Genre searches made: "genre|decade" → offsets fetched and the total Spotify reported. */
  searched: Record<string, { offsets: number[]; total: number | null }>;
  /** Ready-made songs searched again with the closest-year rule (key → when). */
  rechecked?: Record<string, string>;
  /** Spotify ids checked with oEmbed: the title Spotify gives, or "" when the id doesn't work. */
  oembed?: Record<string, string>;
  /** Ready-made songs already looked up on Wikidata (key → when). */
  wikidata?: Record<string, string>;
  /** Ids of hand-picked genre songs that aren't in a deck (title|artist → id). */
  genreIds?: Record<string, string>;
  /** Ready-made songs that matched nothing, with why. */
  unmatched?: Record<string, string>;
  /** Ready-made songs whose Spotify year differs from the deck's year. */
  yearNotes?: Record<string, string>;
}

const readJson = <T,>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

const ids = readJson<Record<string, string>>(IDS_FILE, {});
const pools = readJson<GenrePools>(POOLS_FILE, {});
const progress = readJson<Progress>(PROGRESS_FILE, { tried: {}, searched: {} });
progress.unmatched ??= {};
progress.yearNotes ??= {};
progress.wikidata ??= {};
progress.rechecked ??= {};
progress.oembed ??= {};
progress.genreIds ??= {};
Object.assign(ids, progress.genreIds);

const sortKeys = <T,>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

function save(): void {
  // Deck songs' ids go in track-ids.json (the game reads it); the rest only feed the genre lists.
  const deckKeys = new Set(DECKS.flatMap(([, songs]) => songs.map(premadeKey)));
  const deckIds = Object.fromEntries(Object.entries(ids).filter(([k]) => deckKeys.has(k)));
  progress.genreIds = sortKeys(Object.fromEntries(Object.entries(ids).filter(([k]) => !deckKeys.has(k))));
  buildGenrePools();
  writeFileSync(IDS_FILE, JSON.stringify(sortKeys(deckIds), null, 1) + '\n');
  const sortedPools = Object.fromEntries(
    Object.entries(pools)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([g, rows]) => [g, [...rows].sort((a, b) => a[2] - b[2] || a[0].localeCompare(b[0]))]),
  );
  // One song per line keeps the diffs readable.
  const poolJson =
    '{\n' +
    Object.entries(sortedPools)
      .map(([g, rows]) => ` ${JSON.stringify(g)}: [\n${rows.map((r) => '  ' + JSON.stringify(r)).join(',\n')}\n ]`)
      .join(',\n') +
    '\n}\n';
  writeFileSync(POOLS_FILE, Object.keys(sortedPools).length ? poolJson : '{}\n');
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

// ---- 1. Ids for the ready-made decks ----

const DECKS: [name: string, songs: Song[]][] = [
  ['Classic hits', DEFAULT_SONGS],
  ['Movie songs', MOVIE_SONGS],
  ['Musicals', MUSICAL_SONGS],
  ['TV themes', TV_SONGS],
  ['Video game music', GAME_SONGS],
];

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
export function bestMatch(song: Song, items: SpotifyTrack[]): { track: SpotifyTrack & { id: string }; earliest: number | null } | null {
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
  const todo = GROUPS.flatMap(([, songs]) => songs).filter((s) => {
    const key = premadeKey(s);
    return !s.spotifyId && !ids[key] && !progress.tried[key] && !progress.wikidata![key];
  });
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
      const key = premadeKey(song);
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
            ids[key] = id;
            delete progress.unmatched![key];
            console.log(`✓ ${song.title} – ${song.artist}: ${id} (Wikidata)`);
            break;
          }
        } catch {
          /* try the next id, or search later */
        }
      }
      progress.wikidata![key] = new Date().toISOString().slice(0, 10);
    }
    save();
  }
}

async function fillPremadeIds(): Promise<void> {
  for (const [deck, songs] of GROUPS) {
    for (const song of songs) {
      const key = premadeKey(song);
      if (song.spotifyId || ids[key] || progress.tried[key]) continue;
      const firstArtist = song.artist.split(/\s*(?:,|&|feat\.|ft\.)\s*/i)[0];
      // At most two searches: the exact one, then a looser one.
      const queries = [`track:"${quoteless(song.title)}" artist:"${quoteless(firstArtist)}"`, `${quoteless(song.title)} ${quoteless(firstArtist)}`];
      let found: ReturnType<typeof bestMatch> = null;
      for (const q of queries) {
        found = bestMatch(song, (await search(q)).items);
        if (found) break;
      }
      progress.tried[key] = new Date().toISOString().slice(0, 10);
      if (found) {
        ids[key] = found.track.id;
        delete progress.unmatched![key];
        if (found.earliest !== null && Math.abs(found.earliest - song.year) > 1) {
          progress.yearNotes![key] = `${deck}: the deck says ${song.year}, Spotify's earliest release is ${found.earliest} (${found.track.album.name}).`;
        }
        console.log(`✓ ${song.title} – ${song.artist}: ${found.track.id}`);
      } else {
        progress.unmatched![key] = `${deck}: no recording with this title by this artist.`;
        console.log(`✗ ${song.title} – ${song.artist}: no match`);
      }
      save();
    }
  }
}

// ---- 2. Genre lists ----

/** Deck songs by song key: their checked year and id win. */
const CURATED = new Map(DECKS.flatMap(([, songs]) => songs.map((s) => [songKey(s.title, s.artist), s] as const)));

/** Hand-picked genre songs that aren't in a deck: these need their own id. */
const GENRE_ONLY: Song[] = (() => {
  const seen = new Set<string>();
  const out: Song[] = [];
  for (const rows of Object.values(GENRE_SONGS)) {
    for (const [title, artist, year] of rows) {
      const key = songKey(title, artist);
      if (CURATED.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ id: `g${out.length + 1}`, title, artist, year });
    }
  }
  return out;
})();

const GROUPS: [name: string, songs: Song[]][] = [...DECKS, ['Genre lists', GENRE_ONLY]];

/** Rebuilds genre-pools.json from scripts/genre-songs.ts and the ids found. Songs without an id are left out. */
function buildGenrePools(): void {
  for (const key of Object.keys(pools)) delete pools[key];
  for (const [genre, rows] of Object.entries(GENRE_SONGS)) {
    const seen = new Set<string>();
    const out: PoolRow[] = [];
    for (const [title, artist, year] of rows) {
      const key = songKey(title, artist);
      if (seen.has(key)) continue;
      seen.add(key);
      const deck = CURATED.get(key);
      const id = deck ? (deck.spotifyId ?? ids[premadeKey(deck)]) : ids[premadeKey({ title, artist })];
      if (id) out.push(deck ? [deck.title, deck.artist, deck.year, id] : [title, artist, year, id]);
    }
    pools[genre] = out;
  }
}

/**
 * The first run picked the earliest release, which for some songs was a
 * compilation with a broken date. Songs whose Spotify year looked odd are
 * searched once more and get the release closest to their known year.
 */
async function recheckOddYears(): Promise<void> {
  const all = new Map(DECKS.flatMap(([deck, songs]) => songs.map((s) => [premadeKey(s), { s, deck }] as const)));
  for (const key of Object.keys(progress.yearNotes ?? {})) {
    const entry = all.get(key);
    if (!entry || progress.rechecked![key] || !ids[key]) continue;
    const { s: song, deck } = entry;
    const firstArtist = song.artist.split(/\s*(?:,|&|feat\.|ft\.)\s*/i)[0];
    const found = bestMatch(song, (await search(`track:"${quoteless(song.title)}" artist:"${quoteless(firstArtist)}"`)).items);
    progress.rechecked![key] = new Date().toISOString().slice(0, 10);
    if (found) {
      const year = releaseYear(found.track.album.release_date);
      if (found.track.id !== ids[key]) console.log(`↻ ${song.title} – ${song.artist}: ${ids[key]} → ${found.track.id} (${found.track.album.name}, ${year})`);
      ids[key] = found.track.id;
      if (year !== null && Math.abs(year - song.year) > 1) {
        progress.yearNotes![key] = `${deck}: the deck says ${song.year}; the recording used is from ${year} (${found.track.album.name}).`;
      } else delete progress.yearNotes![key];
    }
    save();
  }
}

// ---- Report ----

function review(): string {
  const all = DECKS.flatMap(([, s]) => s);
  // Songs taken out of the decks since are left out.
  const inDecks = new Set(all.map(premadeKey));
  const unmatched = Object.entries(progress.unmatched ?? {}).filter(([k]) => inDecks.has(k));
  const genreKeys = new Set(GENRE_ONLY.map(premadeKey));
  const genreMissing = Object.entries(progress.unmatched ?? {}).filter(([k]) => genreKeys.has(k));
  const years = Object.entries(progress.yearNotes ?? {}).filter(([k]) => inDecks.has(k));
  const withId = all.filter((s) => s.spotifyId || ids[premadeKey(s)]).length;
  const lines = [
    '# Spotify data: needs a look',
    '',
    'Written by `scripts/spotify-precompute.ts`. Songs listed here have no Spotify id',
    'yet and stay out of the no-login game. Fix them by hand in `track-ids.json`',
    '(key `title|artist`), or correct the song in its deck.',
    '',
    `Ready-made songs with an id: **${withId} of ${all.length}**.`,
    '',
    '## Not found on Spotify',
    '',
    ...(unmatched.length ? unmatched.map(([k, why]) => `- ${k.replace('|', ' – ')}: ${why}`) : ['None.']),
    '',
    '## Year differs from Spotify',
    '',
    'The deck year was kept. Spotify is often wrong (it dates songs by album), but these are worth a check.',
    '',
    ...(years.length ? years.map(([k, why]) => `- ${k.replace('|', ' – ')}: ${why}`) : ['None.']),
    '',
    '## Genre lists',
    '',
    'From `scripts/genre-songs.ts`. Songs not found on Spotify are left out of the lists:',
    '',
    ...(genreMissing.length ? genreMissing.map(([k]) => `- ${k.replace('|', ' – ')}`) : ['None.']),
    '',
    `| Genre | ${DECADES.map((d) => `${String(d).slice(2)}s`).join(' | ')} | Total |`,
    `|---|${DECADES.map(() => '---:').join('|')}|---:|`,
    ...SEARCH_GENRES.map((g) => {
      const rows = pools[g.id] ?? [];
      const counts = DECADES.map((d) => rows.filter((r) => r[2] >= d && r[2] <= d + 9).length);
      return `| ${g.id} | ${counts.join(' | ')} | ${rows.length} |`;
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
    await fillPremadeIds();
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
