/**
 * Builds the host's own song list from Spotify, in one of two ways:
 * by genre and years (a few searches), or from playlists the host picks
 * (one request lists them all). The result is kept in this browser only.
 */
import type { Song } from '../game/engine';
import { RateLimitError, spotifyGet, SpotifyError } from './api';
import type { Genre } from '../data/genres';
import {
  earliestYear,
  needsYearCheck,
  releaseYear,
  songsFromSearch,
  spreadPick,
  trackToSong,
  uniqueTracks,
  withContributor,
  yearSlices,
  type Contributor,
  type PersonalDeck,
  type SpotifyTrack,
  type YearSlice,
} from './personalDeck';

const DECK_KEY = 'mq.personalDeck';
const CACHE_KEY = 'mq.spotifyCache';

/** The most genre searches one list may cost. */
export const MAX_GENRE_REQUESTS = 12;
/** How many genres can be picked at once. */
export const MAX_GENRES = 4;
/** Playlists listed per request (Spotify's maximum). */
const PLAYLIST_PAGE = 50;
/** Tracks per playlist request (Spotify's maximum), and how many requests per playlist at most. */
const TRACK_PAGE = 100;
const PAGES_PER_PLAYLIST = 3;
/** Upper bound on cards, which also bounds the number of year lookups. */
const MAX_TRACKS = 400;
/**
 * Requests are sent one after the other with a short pause, so a list never
 * comes as a burst; Spotify answers bursts with "too many requests".
 */
const PAUSE_MS = 250;
/** Year checks are many small searches: two at a time. */
const YEAR_CHECK_CONCURRENCY = 2;
/** Remembered year lookups, so building again is quick. */
const CACHE_LIMIT = 8000;

/** Reading playlists needs these on top of the login's usual access. */
export const PLAYLIST_SCOPES = ['playlist-read-private', 'playlist-read-collaborative'];

/** Genres the host can build a list from, with the Spotify genre each one searches. */
export const SEARCH_GENRES: { id: string; label: string; query: string; genre?: Genre }[] = [
  { id: 'pop', label: 'Pop', query: 'pop', genre: 'pop' },
  { id: 'rock', label: 'Rock', query: 'rock', genre: 'rock' },
  { id: 'hiphop', label: 'Hip-hop', query: 'hip hop', genre: 'hiphop' },
  { id: 'rnb', label: 'R&B', query: 'r&b', genre: 'hiphop' },
  { id: 'soul', label: 'Soul', query: 'soul', genre: 'soul' },
  { id: 'disco', label: 'Disco & funk', query: 'disco', genre: 'soul' },
  { id: 'dance', label: 'Dance', query: 'dance', genre: 'dance' },
  { id: 'country', label: 'Country', query: 'country' },
  { id: 'metal', label: 'Metal', query: 'metal', genre: 'rock' },
  { id: 'indie', label: 'Indie', query: 'indie', genre: 'rock' },
  { id: 'schlager', label: 'Schlager', query: 'schlager', genre: 'swedish' },
  { id: 'swedishpop', label: 'Swedish pop', query: 'swedish pop', genre: 'swedish' },
  { id: 'jazz', label: 'Jazz', query: 'jazz', genre: 'soul' },
  { id: 'reggae', label: 'Reggae', query: 'reggae' },
  { id: 'latin', label: 'Latin', query: 'latin' },
  { id: 'punk', label: 'Punk', query: 'punk', genre: 'rock' },
];

// ---- The saved list ----

export function loadPersonalDeck(): PersonalDeck | null {
  try {
    const deck = JSON.parse(localStorage.getItem(DECK_KEY) ?? 'null') as PersonalDeck | null;
    return deck?.version === 1 && Array.isArray(deck.contributors) && deck.contributors.length ? deck : null;
  } catch {
    return null;
  }
}

/** Saves the host's list, replacing the one built before. */
export function savePersonalDeck(contributor: Contributor): PersonalDeck {
  const deck = withContributor(null, contributor);
  try {
    localStorage.setItem(DECK_KEY, JSON.stringify(deck));
  } catch {
    /* storage full: the list still works for this game */
  }
  return deck;
}

// ---- Cache of original years, by track ----

function readYearCache(): Record<string, number | null> {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    if (c && typeof c.years === 'object') return c.years;
  } catch {
    /* ignore */
  }
  return {};
}

function writeYearCache(years: Record<string, number | null>): void {
  const entries = Object.entries(years);
  const kept = entries.length > CACHE_LIMIT ? Object.fromEntries(entries.slice(-CACHE_LIMIT)) : years;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ years: kept, genres: {} }));
  } catch {
    /* the cache is only a speed-up */
  }
}

// ---- Helpers ----

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `task` for every item, `concurrency` at a time with a pause between
 * requests. If Spotify says to stop (rate limited), no further items are
 * started and the error is returned, so the caller can keep what it has.
 */
async function paced<T>(items: readonly T[], concurrency: number, task: (item: T) => Promise<void>): Promise<RateLimitError | null> {
  let next = 0;
  let stopped: RateLimitError | null = null;
  const worker = async () => {
    while (!stopped && next < items.length) {
      const item = items[next++];
      try {
        await task(item);
      } catch (e) {
        if (e instanceof RateLimitError) stopped = e;
        else throw e;
      }
      if (!stopped && next < items.length) await pause(PAUSE_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return stopped;
}

async function searchOriginalYear(track: SpotifyTrack & { id: string }): Promise<number | null> {
  const title = track.name.replace(/["]/g, '').replace(/\s+-\s+.*$/, '');
  const q = `track:"${title}" artist:"${track.artists[0].name.replace(/["]/g, '')}"`;
  try {
    const body = await spotifyGet<{ tracks?: { items: SpotifyTrack[] } }>(
      `/search?${new URLSearchParams({ q, type: 'track', limit: '10' })}`,
    );
    return earliestYear(track, body.tracks?.items ?? []);
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    // The album year is still a reasonable answer.
    return releaseYear(track.album.release_date);
  }
}

export interface BuildProgress {
  /** What is happening, for the person to read. */
  label: string;
  done: number;
  total: number;
}

// ---- By genre ----

/** The searches a genre list makes: one per genre per year slice. */
export function genrePlan(genreIds: readonly string[], from: number, to: number): { slices: YearSlice[]; requests: number } {
  const slices = yearSlices(from, to, genreIds.length, MAX_GENRE_REQUESTS);
  return { slices, requests: slices.length * genreIds.length };
}

/** Spotify may cap search results lower for some apps; fall back once and remember. */
let searchLimit = 50;

async function genreSearch(query: string, slice: YearSlice): Promise<SpotifyTrack[]> {
  const q = `genre:"${query}" year:${slice.from}-${slice.to}`;
  const run = (limit: number) =>
    spotifyGet<{ tracks?: { items: SpotifyTrack[] } }>(`/search?${new URLSearchParams({ q, type: 'track', limit: String(limit) })}`);
  try {
    return (await run(searchLimit)).tracks?.items ?? [];
  } catch (e) {
    if (e instanceof SpotifyError && e.status === 400 && searchLimit > 10) {
      searchLimit = 10;
      return (await run(searchLimit)).tracks?.items ?? [];
    }
    throw e;
  }
}

/**
 * Builds a list from genre searches. Songs are dated by their album, so no
 * lookups are needed beyond the searches themselves.
 */
export async function buildFromGenres(
  genreIds: readonly string[],
  from: number,
  to: number,
  onProgress: (p: BuildProgress) => void = () => {},
): Promise<{ songs: Song[]; note: string | null }> {
  const genres = SEARCH_GENRES.filter((g) => genreIds.includes(g.id));
  const { slices } = genrePlan(genreIds, from, to);
  const jobs = genres.flatMap((genre) => slices.map((slice) => ({ genre, slice })));
  const results: Song[][] = new Array(jobs.length).fill([]);
  let done = 0;
  let failed = 0;
  let lastError: unknown = null;
  onProgress({ label: 'Searching Spotify', done, total: jobs.length });
  const limited = await paced(
    jobs.map((job, i) => ({ ...job, i })),
    1,
    async ({ genre, slice, i }) => {
      onProgress({ label: `Searching Spotify: ${genre.label}, ${slice.from}–${slice.to}`, done, total: jobs.length });
      try {
        const songs = songsFromSearch(await genreSearch(genre.query, slice), slice);
        results[i] = genre.genre ? songs.map((s) => ({ ...s, genres: [genre.genre!] })) : songs;
      } catch (e) {
        if (e instanceof RateLimitError) throw e;
        failed++;
        lastError = e;
      }
      onProgress({ label: `Searching Spotify: ${genre.label}, ${slice.from}–${slice.to}`, done: ++done, total: jobs.length });
    },
  );
  const songs = mergeById(results.flat());
  if (songs.length === 0) {
    if (limited) throw limited;
    if (failed === jobs.length && lastError) throw lastError;
  }
  const note = limited ? `Spotify kept refusing the game, so ${done} of ${jobs.length} searches were made.` : null;
  return { songs, note };
}

function mergeById(songs: Song[]): Song[] {
  const seen = new Set<string>();
  return songs.filter((s) => {
    const key = `${s.title.toLowerCase()}|${s.artist.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- From playlists ----

export interface PlaylistSummary {
  id: string;
  name: string;
  owner: string;
  image: string | null;
  tracks: number;
}

interface RawPlaylist {
  id: string;
  name: string;
  owner?: { display_name?: string | null; id?: string };
  images?: { url: string; width?: number | null }[] | null;
  tracks?: { total?: number };
  items?: { total?: number };
}

/** Lists the host's playlists with ONE request (50 at a time; `offset` for the next 50). */
export async function fetchPlaylists(offset = 0): Promise<{ playlists: PlaylistSummary[]; total: number }> {
  const page = await spotifyGet<{ items: (RawPlaylist | null)[]; total: number }>(`/me/playlists?limit=${PLAYLIST_PAGE}&offset=${offset}`);
  const playlists = page.items
    .filter((p): p is RawPlaylist => !!p?.id)
    .map((p) => ({
      id: p.id,
      name: p.name || 'Untitled playlist',
      owner: p.owner?.display_name || p.owner?.id || '',
      // The smallest cover that still looks sharp.
      image: [...(p.images ?? [])].sort((a, b) => (a.width ?? 999) - (b.width ?? 999)).find((i) => (i.width ?? 999) >= 60)?.url ?? p.images?.[0]?.url ?? null,
      tracks: p.tracks?.total ?? p.items?.total ?? 0,
    }));
  return { playlists, total: page.total };
}

const TRACK_FIELDS = 'items(track(id,name,is_local,type,artists(id,name),album(name,album_type,release_date)))';

async function playlistPage(id: string, offset: number): Promise<SpotifyTrack[]> {
  const query = `limit=${TRACK_PAGE}&offset=${offset}&fields=${encodeURIComponent(TRACK_FIELDS)}`;
  type Page = { items: { track?: (SpotifyTrack & { type?: string }) | null; item?: (SpotifyTrack & { type?: string }) | null }[] };
  let page: Page;
  try {
    page = await spotifyGet<Page>(`/playlists/${encodeURIComponent(id)}/tracks?${query}`);
  } catch (e) {
    // Newer apps read playlist contents from /items instead.
    if (!(e instanceof SpotifyError) || (e.status !== 403 && e.status !== 404 && e.status !== 410)) throw e;
    page = await spotifyGet<Page>(`/playlists/${encodeURIComponent(id)}/items?limit=${TRACK_PAGE}&offset=${offset}`);
  }
  return page.items
    .map((it) => it.track ?? it.item)
    .filter((t): t is SpotifyTrack & { type?: string } => !!t && (t.type ?? 'track') === 'track');
}

/**
 * Reads the chosen playlists (one request per 100 songs) and dates every
 * song. Songs on compilations or remasters get one search each for the
 * original year; everything else is dated by its album.
 */
export async function buildFromPlaylists(
  playlists: readonly PlaylistSummary[],
  onProgress: (p: BuildProgress) => void = () => {},
): Promise<{ songs: Song[]; skipped: string[]; note: string | null }> {
  const jobs = playlists.flatMap((p) =>
    Array.from({ length: Math.max(1, Math.min(PAGES_PER_PLAYLIST, Math.ceil(p.tracks / TRACK_PAGE))) }, (_, page) => ({ p, offset: page * TRACK_PAGE })),
  );
  const pages: SpotifyTrack[][] = new Array(jobs.length).fill([]);
  const skipped = new Set<string>();
  let done = 0;
  onProgress({ label: 'Reading playlists', done, total: jobs.length });
  const limitedReading = await paced(
    jobs.map((job, i) => ({ ...job, i })),
    1,
    async ({ p, offset, i }) => {
      try {
        pages[i] = await playlistPage(p.id, offset);
      } catch (e) {
        if (e instanceof RateLimitError) throw e;
        // Spotify refuses some playlists (for example its own editorial ones).
        skipped.add(p.name);
      }
      onProgress({ label: `Reading ${p.name}`, done: ++done, total: jobs.length });
    },
  );

  const albumYear = (t: SpotifyTrack) => releaseYear(t.album.release_date);
  const tracks = spreadPick(uniqueTracks(pages.flat()), MAX_TRACKS, albumYear);
  const cache = readYearCache();
  const years = new Map<string, number | null>();
  const toSearch: typeof tracks = [];
  for (const t of tracks) {
    if (t.id in cache) years.set(t.id, cache[t.id]);
    else if (needsYearCheck(t)) toSearch.push(t);
    else years.set(t.id, albumYear(t));
  }
  done = 0;
  if (toSearch.length) onProgress({ label: `Checking the original year of ${toSearch.length} remastered songs`, done, total: toSearch.length });
  const limitedChecks = limitedReading ? null : await paced(toSearch, YEAR_CHECK_CONCURRENCY, async (t) => {
    const year = await searchOriginalYear(t);
    years.set(t.id, year);
    cache[t.id] = year;
    onProgress({ label: `Checking the original year of ${toSearch.length} remastered songs`, done: ++done, total: toSearch.length });
  });
  writeYearCache(cache);

  const songs: Song[] = [];
  for (const t of tracks) {
    const year = years.get(t.id);
    if (year != null) songs.push(trackToSong(t, year));
  }
  const limited = limitedReading ?? limitedChecks;
  if (songs.length === 0 && limited) throw limited;
  const note = limitedReading
    ? 'Spotify kept refusing the game, so only part of the playlists was read.'
    : limitedChecks
      ? "Spotify kept refusing the game, so some remastered songs whose original year wasn't checked were left out."
      : null;
  return { songs, skipped: [...skipped], note };
}
