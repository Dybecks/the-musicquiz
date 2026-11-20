/**
 * Reads what a logged-in person listens to on Spotify and turns it into a
 * song deck. Only runs after the person has chosen which data to share and
 * granted the matching permissions. The result is kept in this browser only.
 */
import type { Song } from '../game/engine';
import { spotifyGet } from './api';
import { filterSongs, genresFromSpotify, NO_FILTER, type DeckFilter, type Genre } from '../data/genres';
import {
  SOURCE_SCOPES,
  couldMatchYears,
  earliestYear,
  needsYearCheck,
  releaseYear,
  spreadPick,
  trackToSong,
  uniqueTracks,
  withContributor,
  withoutContributor,
  type Contributor,
  type ListeningSource,
  type PersonalDeck,
  type SpotifyTrack,
} from './personalDeck';

const DECK_KEY = 'mq.personalDeck';
const SOURCES_KEY = 'mq.personalSources';
const CACHE_KEY = 'mq.spotifyCache';

/** Spotify allows at most this many tracks per page of these endpoints. */
const PAGE = 50;
/** Liked songs: how many pages of 50 to read at most. */
const LIKED_PAGES = 20;
/** Playlists: how many to read, and how many tracks from each. */
const PLAYLISTS = 20;
const PLAYLIST_TRACKS = 100;
/** Upper bound on cards, which also bounds the number of year lookups. */
const MAX_TRACKS = 600;
/** Lookups run this many at a time. */
const CONCURRENCY = 8;
/** Remembered lookups, so loading again (other genres, other years) is quick. */
const CACHE_LIMIT = 8000;

export function scopesFor(sources: ListeningSource[]): string[] {
  return sources.map((s) => SOURCE_SCOPES[s]);
}

export function loadSources(): ListeningSource[] {
  try {
    const saved = JSON.parse(localStorage.getItem(SOURCES_KEY) ?? 'null');
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {
    /* ignore */
  }
  return ['top', 'recent'];
}

export function saveSources(sources: ListeningSource[]): void {
  localStorage.setItem(SOURCES_KEY, JSON.stringify(sources));
}

export function loadPersonalDeck(): PersonalDeck | null {
  try {
    const deck = JSON.parse(localStorage.getItem(DECK_KEY) ?? 'null') as PersonalDeck | null;
    return deck?.version === 1 && Array.isArray(deck.contributors) && deck.contributors.length ? deck : null;
  } catch {
    return null;
  }
}

function storeDeck(deck: PersonalDeck | null): PersonalDeck | null {
  if (deck) localStorage.setItem(DECK_KEY, JSON.stringify(deck));
  else localStorage.removeItem(DECK_KEY);
  return deck;
}

/** Adds or replaces one person's music (the host's, or a friend's). */
export function savePersonalDeck(contributor: Contributor): PersonalDeck {
  return storeDeck(withContributor(loadPersonalDeck(), contributor))!;
}

/** Removes one person's music; returns what is left. */
export function removeContributor(userId: string): PersonalDeck | null {
  return storeDeck(withoutContributor(loadPersonalDeck(), userId));
}

export function forgetPersonalDeck(): void {
  localStorage.removeItem(DECK_KEY);
}

// ---- Cache of original years (by track) and genres (by artist) ----

interface LookupCache {
  years: Record<string, number | null>;
  genres: Record<string, Genre[]>;
}

function readCache(): LookupCache {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    if (c && typeof c.years === 'object' && typeof c.genres === 'object') return c;
  } catch {
    /* ignore */
  }
  return { years: {}, genres: {} };
}

/** Keeps the newest entries; storage is limited. */
function trim<T>(record: Record<string, T>): Record<string, T> {
  const entries = Object.entries(record);
  return entries.length > CACHE_LIMIT ? Object.fromEntries(entries.slice(-CACHE_LIMIT)) : record;
}

function writeCache(cache: LookupCache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ years: trim(cache.years), genres: trim(cache.genres) }));
  } catch {
    /* storage full: the cache is only a speed-up */
  }
}

// ---- Reading listening data ----

interface Paged<T> {
  items: T[];
  next: string | null;
}

/** Runs `task` for every item, `CONCURRENCY` at a time. */
async function eachConcurrently<T>(items: readonly T[], task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

async function topTracks(): Promise<SpotifyTrack[]> {
  const requests = ['long_term', 'medium_term', 'short_term'].flatMap((range) =>
    [0, 49].map((offset) => `/me/top/tracks?time_range=${range}&limit=${PAGE}&offset=${offset}`),
  );
  const pages: SpotifyTrack[][] = new Array(requests.length).fill([]);
  await eachConcurrently(
    requests.map((path, i) => ({ path, i })),
    async ({ path, i }) => {
      try {
        pages[i] = (await spotifyGet<Paged<SpotifyTrack>>(path)).items;
      } catch (e) {
        if (i % 2 === 0) throw e; // the second page may simply not exist
      }
    },
  );
  // Long term first: those are the songs someone really knows.
  return pages.flat();
}

async function recentTracks(): Promise<SpotifyTrack[]> {
  const page = await spotifyGet<Paged<{ track: SpotifyTrack }>>(`/me/player/recently-played?limit=${PAGE}`);
  return page.items.map((i) => i.track);
}

async function likedTracks(): Promise<SpotifyTrack[]> {
  // The first page says how many there are; the rest are read in parallel.
  const first = await spotifyGet<Paged<{ track: SpotifyTrack }> & { total: number }>(`/me/tracks?limit=${PAGE}`);
  const pages = Math.min(LIKED_PAGES, Math.ceil(first.total / PAGE));
  const rest: SpotifyTrack[][] = new Array(Math.max(0, pages - 1)).fill([]);
  await eachConcurrently(
    rest.map((_, i) => i),
    async (i) => {
      try {
        const page = await spotifyGet<Paged<{ track: SpotifyTrack }>>(`/me/tracks?limit=${PAGE}&offset=${(i + 1) * PAGE}`);
        rest[i] = page.items.map((item) => item.track);
      } catch {
        /* keep what was read */
      }
    },
  );
  return [...first.items.map((item) => item.track), ...rest.flat()];
}

const PLAYLIST_FIELDS = 'items(track(id,name,is_local,type,artists(id,name),album(name,album_type,release_date)))';

async function playlistTracks(): Promise<SpotifyTrack[]> {
  const lists = await spotifyGet<Paged<{ id: string } | null>>(`/me/playlists?limit=${PLAYLISTS}`);
  const ids = lists.items.filter((p): p is { id: string } => !!p?.id).map((p) => p.id);
  const out: SpotifyTrack[][] = new Array(ids.length).fill([]);
  await eachConcurrently(
    ids.map((id, i) => ({ id, i })),
    async ({ id, i }) => {
      const query = `limit=${PLAYLIST_TRACKS}&fields=${encodeURIComponent(PLAYLIST_FIELDS)}`;
      try {
        // Spotify may refuse some playlists (for example its own editorial ones); skip those.
        const page = await spotifyGet<{ items: { track: (SpotifyTrack & { type?: string }) | null }[] }>(
          `/playlists/${encodeURIComponent(id)}/tracks?${query}`,
        );
        out[i] = page.items.map((it) => it.track).filter((t): t is SpotifyTrack => !!t && (t.type ?? 'track') === 'track');
      } catch {
        /* skip this playlist */
      }
    },
  );
  return out.flat();
}

const READERS: Record<ListeningSource, () => Promise<SpotifyTrack[]>> = {
  top: topTracks,
  recent: recentTracks,
  liked: likedTracks,
  playlists: playlistTracks,
};

async function searchOriginalYear(track: SpotifyTrack & { id: string }): Promise<number | null> {
  const title = track.name.replace(/["]/g, '').replace(/\s+-\s+.*$/, '');
  const q = `track:"${title}" artist:"${track.artists[0].name.replace(/["]/g, '')}"`;
  try {
    const body = await spotifyGet<{ tracks?: { items: SpotifyTrack[] } }>(
      `/search?${new URLSearchParams({ q, type: 'track', limit: '10' })}`,
    );
    return earliestYear(track, body.tracks?.items ?? []);
  } catch {
    // The album year is still a reasonable answer.
    return releaseYear(track.album.release_date);
  }
}

export interface GatherProgress {
  step: 'reading' | 'genres' | 'dating';
  done: number;
  total: number;
}

export interface GatherResult {
  songs: Song[];
  /** Sources that could not be read, with the reason. */
  failures: { source: ListeningSource; message: string }[];
}

/**
 * Reads the chosen listening data and builds cards with each song's original
 * release year. Only songs that match the filter are kept, and the slow
 * lookups skip songs that can't match it. When there are more songs than
 * the limit, the songs kept are spread over the decades.
 */
export async function gatherListening(
  sources: ListeningSource[],
  filter: DeckFilter = NO_FILTER,
  onProgress: (p: GatherProgress) => void = () => {},
): Promise<GatherResult> {
  const failures: GatherResult['failures'] = [];
  const raw: SpotifyTrack[][] = new Array(sources.length).fill([]);
  let read = 0;
  onProgress({ step: 'reading', done: 0, total: sources.length });
  await Promise.all(
    sources.map(async (source, i) => {
      try {
        raw[i] = await READERS[source]();
      } catch (e) {
        failures.push({ source, message: e instanceof Error ? e.message : String(e) });
      }
      onProgress({ step: 'reading', done: ++read, total: sources.length });
    }),
  );

  const cache = readCache();
  const albumYear = (t: SpotifyTrack) => releaseYear(t.album.release_date);
  let candidates = uniqueTracks(raw.flat()).filter((t) => couldMatchYears(t, filter));
  // Without a genre choice, genres are only extra information, so look them
  // up for the songs that are kept. With one, look them up first and drop
  // songs from other genres before dating anything.
  if (filter.genres.length === 0) candidates = spreadPick(candidates, MAX_TRACKS, albumYear);
  const genres = await artistGenres([...new Set(candidates.map((t) => t.artists[0].id))], cache, onProgress);
  const genresOf = (t: SpotifyTrack) => genres.get(t.artists[0].id) ?? [];
  const tracks = spreadPick(
    candidates.filter((t) => filter.genres.length === 0 || genresOf(t).some((g) => filter.genres.includes(g))),
    MAX_TRACKS,
    albumYear,
  );

  // Most songs are on their original album and are dated by it. Only songs
  // on compilations, reissues and the like are searched for an older release.
  const years = new Map<string, number | null>();
  const toSearch: typeof tracks = [];
  for (const t of tracks) {
    if (t.id in cache.years) years.set(t.id, cache.years[t.id]);
    else if (needsYearCheck(t)) toSearch.push(t);
    else years.set(t.id, albumYear(t));
  }
  let done = 0;
  onProgress({ step: 'dating', done, total: toSearch.length });
  await eachConcurrently(toSearch, async (t) => {
    const year = await searchOriginalYear(t);
    years.set(t.id, year);
    cache.years[t.id] = year;
    onProgress({ step: 'dating', done: ++done, total: toSearch.length });
  });
  writeCache(cache);

  const songs: Song[] = [];
  for (const t of tracks) {
    const year = years.get(t.id);
    if (year == null) continue;
    const song = trackToSong(t, year);
    const g = genresOf(t);
    if (g.length) song.genres = g;
    songs.push(song);
  }
  return { songs: filterSongs(songs, filter), failures };
}

async function artistGenres(
  ids: string[],
  cache: LookupCache,
  onProgress: (p: GatherProgress) => void,
): Promise<Map<string, Genre[]>> {
  const out = new Map<string, Genre[]>();
  const missing: string[] = [];
  for (const id of ids) {
    if (id in cache.genres) out.set(id, cache.genres[id]);
    else missing.push(id);
  }
  const found = (id: string, names: string[]) => {
    const g = genresFromSpotify(names);
    out.set(id, g);
    cache.genres[id] = g;
  };

  let done = 0;
  onProgress({ step: 'genres', done, total: missing.length });
  // 50 artists per request where Spotify allows it.
  const batches: string[][] = [];
  for (let i = 0; i < missing.length; i += 50) batches.push(missing.slice(i, i + 50));
  let batchWorks = true;
  await eachConcurrently(batches, async (batch) => {
    if (!batchWorks) return;
    try {
      const body = await spotifyGet<{ artists: ({ id: string; genres?: string[] } | null)[] }>(
        `/artists?ids=${batch.map(encodeURIComponent).join(',')}`,
      );
      for (const a of body.artists) if (a) found(a.id, a.genres ?? []);
      done += batch.length;
      onProgress({ step: 'genres', done, total: missing.length });
    } catch {
      batchWorks = false;
    }
  });

  // Some apps can't use the batch request: look the rest up one by one, and
  // stop early if artist lookups aren't available at all. Songs whose
  // artist has no genre simply have none, and are left out when the host
  // filters by genre.
  const rest = missing.filter((id) => !out.has(id));
  let failuresInARow = 0;
  await eachConcurrently(rest, async (id) => {
    if (failuresInARow >= 5) return;
    try {
      const artist = await spotifyGet<{ genres?: string[] }>(`/artists/${encodeURIComponent(id)}`);
      found(id, artist.genres ?? []);
      failuresInARow = 0;
    } catch {
      failuresInARow++;
    }
    onProgress({ step: 'genres', done: ++done, total: missing.length });
  });
  return out;
}
