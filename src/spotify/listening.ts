/**
 * Builds the host's own song list from Spotify, in one of two ways:
 * by genre and years (a few searches), or from playlists the host picks
 * (one request lists them all). The result is kept in this browser only.
 */
import type { Song } from '../game/engine';
import { RateLimitError, spotifyGet, SpotifyError } from './api';
import { msg } from '../i18n';
import { filterSongs } from '../data/genres';
import { DEFAULT_SONGS } from '../data/songs';
import { SEARCH_GENRE_DEFS, type SearchGenre } from '../data/searchGenres';
import { loadGenrePools, poolSongs } from '../data/spotifyData';
import {
  earliestYear,
  needsYearCheck,
  releaseYear,
  songsFromSearch,
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
export const MAX_GENRE_REQUESTS = 6;
/** How many genres can be picked at once. */
export const MAX_GENRES = 4;
/** Playlists listed per request (Spotify's maximum). */
const PLAYLIST_PAGE = 50;
/** Tracks per playlist request: one batch. */
const TRACK_PAGE = 50;
/**
 * Genre searches only look this deep into Spotify's results: further down
 * are songs few people would know.
 */
const MAX_SEARCH_OFFSET = 250;
/** Songs fetched before the game starts; more are fetched while playing. */
export const FIRST_BATCH = 12;
/** At most this many original-year searches per batch. */
const YEAR_CHECKS_PER_BATCH = 3;
/**
 * Requests are sent one after the other with a short pause, so a list never
 * comes as a burst; Spotify answers bursts with "too many requests".
 */
const PAUSE_MS = 250;
/** Remembered year lookups, so building again is quick. */
const CACHE_LIMIT = 8000;

/** Reading playlists needs these on top of the login's usual access. */
export const PLAYLIST_SCOPES = ['playlist-read-private', 'playlist-read-collaborative'];

/** The genres of "By genre"; the label is in the current language (searchGenres in src/i18n). */
export const SEARCH_GENRES: { id: string; readonly label: string; query: string; genre?: SearchGenre['genre'] }[] = SEARCH_GENRE_DEFS.map((g) => ({
  ...g,
  get label() {
    return msg().searchGenres[g.id] ?? g.id;
  },
}));

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

// ---- Fetching a few songs at a time ----

/**
 * Where a list's songs come from. The game fetches one batch to start with
 * and another whenever its deck runs low, so a game only costs the requests
 * it actually needs. Each batch is a random page: a random genre and decade
 * at a random depth in Spotify's results, or a random part of a random
 * chosen playlist. Pages already fetched are remembered and not fetched
 * again. Plain JSON, so it is saved with the game.
 */
export type RefillPlan =
  | { kind: 'genres'; genres: string[]; from: number; to: number; asked: Record<string, number[]>; totals: Record<string, number> }
  | { kind: 'playlists'; playlists: Pick<PlaylistSummary, 'id' | 'name' | 'tracks'>[]; asked: Record<string, number[]> };

export interface Batch {
  songs: Song[];
  /** The plan for the next batch; null when everything has been fetched. */
  plan: RefillPlan | null;
}

const pick = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];

/** Offsets (multiples of `page`) below `end` that haven't been fetched yet. */
function freeOffsets(end: number, page: number, asked: readonly number[] = []): number[] {
  const out: number[] = [];
  for (let o = 0; o < end; o += page) if (!asked.includes(o)) out.push(o);
  return out;
}

// ---- By genre ----

// Genre searches are remembered for a week, so building the same list again
// (or one that shares genres and decades) costs no requests.
const SEARCH_CACHE_KEY = 'mq.genreSearchCache';
const SEARCH_CACHE_DAYS = 7;
const SEARCH_CACHE_LIMIT = 120;
type SearchCache = Record<string, { at: number; songs: Song[] }>;

function readSearchCache(): SearchCache {
  try {
    const c = JSON.parse(localStorage.getItem(SEARCH_CACHE_KEY) ?? 'null');
    if (c && typeof c === 'object') return c;
  } catch {
    /* ignore */
  }
  return {};
}

function writeSearchCache(cache: SearchCache): void {
  const fresh = Object.entries(cache)
    .filter(([, v]) => Date.now() - v.at < SEARCH_CACHE_DAYS * 86_400_000)
    .sort((a, b) => a[1].at - b[1].at)
    .slice(-SEARCH_CACHE_LIMIT);
  try {
    localStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify(Object.fromEntries(fresh)));
  } catch {
    /* the cache is only a saving */
  }
}


/** The year spans a genre list searches: decades, joined when many genres are chosen. */
export function genrePlan(genreIds: readonly string[], from: number, to: number): { slices: YearSlice[] } {
  return { slices: yearSlices(from, to, genreIds.length, MAX_GENRE_REQUESTS) };
}

export function newGenrePlan(genres: string[], from: number, to: number): RefillPlan {
  return { kind: 'genres', genres, from, to, asked: {}, totals: {} };
}

/** Spotify may cap search results lower for some apps; fall back once and remember. */
let searchLimit = 50;

async function genreSearch(query: string, slice: YearSlice, offset: number): Promise<{ items: SpotifyTrack[]; total: number }> {
  const q = `genre:"${query}" year:${slice.from}-${slice.to}`;
  const run = async (limit: number) => {
    const body = await spotifyGet<{ tracks?: { items: SpotifyTrack[]; total?: number } }>(
      `/search?${new URLSearchParams({ q, type: 'track', limit: String(limit), offset: String(offset) })}`,
    );
    return { items: body.tracks?.items ?? [], total: body.tracks?.total ?? 0 };
  };
  try {
    return await run(searchLimit);
  } catch (e) {
    if (e instanceof SpotifyError && e.status === 400 && searchLimit > 10) {
      searchLimit = 10;
      return run(searchLimit);
    }
    throw e;
  }
}

/** One random genre search: one request, or none if it was made in the last week. */
async function genreBatch(plan: Extract<RefillPlan, { kind: 'genres' }>): Promise<Batch> {
  const genres = SEARCH_GENRES.filter((g) => plan.genres.includes(g.id));
  const { slices } = genrePlan(plan.genres, plan.from, plan.to);
  const page = searchLimit;
  const options = genres.flatMap((genre) =>
    slices.flatMap((slice) => {
      const key = `${genre.query}|${slice.from}-${slice.to}`;
      const end = Math.min(MAX_SEARCH_OFFSET, plan.totals[key] ?? MAX_SEARCH_OFFSET);
      return freeOffsets(end, page, plan.asked[key]).map((offset) => ({ genre, slice, key, offset }));
    }),
  );
  if (options.length === 0) return { songs: [], plan: null };
  // Each search covers one decade, so take turns: search a decade that has
  // been searched least so far (a random one of those), with a random genre.
  const timesAsked = (sl: YearSlice) =>
    genres.reduce((n, g) => n + (plan.asked[`${g.query}|${sl.from}-${sl.to}`]?.length ?? 0), 0);
  const fewest = Math.min(...options.map((o) => timesAsked(o.slice)));
  const { genre, slice, key, offset } = pick(options.filter((o) => timesAsked(o.slice) === fewest));

  const cache = readSearchCache();
  const cacheKey = `${key}|${offset}`;
  const cached = cache[cacheKey];
  let songs: Song[];
  let total = plan.totals[key];
  if (cached && Date.now() - cached.at < SEARCH_CACHE_DAYS * 86_400_000) {
    songs = cached.songs;
  } else {
    const result = await genreSearch(genre.query, slice, offset);
    total = result.total;
    songs = songsFromSearch(result.items, slice);
    if (genre.genre) songs = songs.map((s) => ({ ...s, genres: [genre.genre!] }));
    cache[cacheKey] = { at: Date.now(), songs };
    writeSearchCache(cache);
  }
  const next: RefillPlan = {
    ...plan,
    asked: { ...plan.asked, [key]: [...(plan.asked[key] ?? []), offset] },
    totals: total === undefined ? plan.totals : { ...plan.totals, [key]: total },
  };
  return { songs, plan: next };
}

// ---- From playlists ----

export function newPlaylistPlan(playlists: readonly PlaylistSummary[]): RefillPlan {
  return { kind: 'playlists', playlists: playlists.map(({ id, name, tracks }) => ({ id, name, tracks })), asked: {} };
}

/**
 * One random page of one chosen playlist (bigger playlists are picked more
 * often). Songs on their original album are dated by it; a few reissues get
 * a search for their original year, the rest wait for a later batch.
 */
async function playlistBatch(plan: Extract<RefillPlan, { kind: 'playlists' }>): Promise<Batch> {
  const options = plan.playlists.flatMap((p) => freeOffsets(Math.max(p.tracks, 1), TRACK_PAGE, plan.asked[p.id]).map((offset) => ({ p, offset })));
  if (options.length === 0) return { songs: [], plan: null };
  const { p, offset } = pick(options);
  let tracks: (SpotifyTrack & { id: string })[] = [];
  try {
    tracks = uniqueTracks(await playlistPage(p.id, offset));
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    // Spotify refuses some playlists (for example its own editorial ones): skip it.
    return { songs: [], plan: { ...plan, playlists: plan.playlists.filter((x) => x.id !== p.id) } };
  }
  const yearCache = readYearCache();
  const songs: Song[] = [];
  const reissues: typeof tracks = [];
  for (const t of tracks) {
    if (t.id in yearCache) {
      const y = yearCache[t.id];
      if (y != null) songs.push(trackToSong(t, y));
    } else if (needsYearCheck(t)) reissues.push(t);
    else {
      const y = releaseYear(t.album.release_date);
      if (y != null) songs.push(trackToSong(t, y));
    }
  }
  for (const t of reissues.sort(() => Math.random() - 0.5).slice(0, YEAR_CHECKS_PER_BATCH)) {
    const y = await searchOriginalYear(t);
    yearCache[t.id] = y;
    if (y != null) songs.push(trackToSong(t, y));
  }
  writeYearCache(yearCache);
  return { songs, plan: { ...plan, asked: { ...plan.asked, [p.id]: [...(plan.asked[p.id] ?? []), offset] } } };
}

// ---- Both ----

/** Fetches the next batch of songs for a list. */
export function fetchBatch(plan: RefillPlan): Promise<Batch> {
  return plan.kind === 'genres' ? genreBatch(plan) : playlistBatch(plan);
}

/**
 * The game's own classic hits for the chosen genres and years. They are
 * mixed into a genre list so it needs fewer Spotify requests, and carry it
 * on their own when Spotify can't be asked. Only songs with a known Spotify
 * link are used: they play without any request.
 */
export function builtInForGenres(genreIds: readonly string[], from: number, to: number): Song[] {
  const genres = [...new Set(SEARCH_GENRES.filter((g) => genreIds.includes(g.id) && g.genre).map((g) => g.genre!))];
  if (genres.length === 0) return [];
  return filterSongs(DEFAULT_SONGS, { genres, fromYear: from, toYear: to }).filter((s) => s.spotifyId);
}

/**
 * With at least this many songs from the game's own genre lists, a genre
 * list asks Spotify nothing at all.
 */
export const ENOUGH_OWN_SONGS = 40;

/**
 * The songs the game already has for these genres and years, with no
 * requests: its own genre lists (looked up on Spotify ahead of time), and,
 * when those are thin, its classic hits in the same wider genres.
 */
export async function ownGenreSongs(genreIds: readonly string[], from: number, to: number): Promise<Song[]> {
  let pools = {};
  try {
    pools = await loadGenrePools();
  } catch {
    /* the lists didn't load (offline with an old cache): use the classic hits */
  }
  const pooled = poolSongs(pools, genreIds, from, to);
  return pooled.length >= ENOUGH_OWN_SONGS ? mergeById(pooled) : mergeById([...pooled, ...builtInForGenres(genreIds, from, to)]);
}

/**
 * Fetches the first few songs, one batch (request) after another, until
 * there are enough to start. A genre list starts from the game's own songs
 * for those genres and years; when there are plenty of them, or there is no
 * login to ask Spotify with, those are the whole list. If Spotify won't
 * answer (the quota is used up), a genre list carries on with the game's
 * own songs, so the host never has to act.
 */
export async function startList(
  plan: RefillPlan,
  onProgress: (p: BuildProgress) => void = () => {},
  want = FIRST_BATCH,
  canAskSpotify = true,
): Promise<{ songs: Song[]; plan: RefillPlan | null; note: string | null }> {
  let songs: Song[] = [];
  if (plan.kind === 'genres') {
    onProgress({ label: msg().errors.pickingSongs, done: 0, total: want });
    songs = await ownGenreSongs(plan.genres, plan.from, plan.to);
    if (songs.length >= ENOUGH_OWN_SONGS || !canAskSpotify) {
      onProgress({ label: msg().errors.pickingSongs, done: want, total: want });
      return { songs, plan: null, note: null };
    }
  }
  let next: RefillPlan | null = plan;
  let tries = 0;
  const label = plan.kind === 'genres' ? msg().errors.findingSongs : msg().errors.readingPlaylists;
  while (next && (tries === 0 || songs.length < want) && tries < 5) {
    onProgress({ label, done: Math.min(songs.length, want), total: want });
    try {
      const batch = await fetchBatch(next);
      songs = mergeById([...songs, ...batch.songs]);
      next = batch.plan;
    } catch (e) {
      if (!(e instanceof RateLimitError) || plan.kind !== 'genres') {
        if (songs.length) break;
        throw e;
      }
      if (songs.length === 0) throw e;
      return { songs, plan: null, note: msg().game.refillFallback(e.message) };
    }
    tries++;
    if (next && songs.length < want) await pause(PAUSE_MS);
  }
  onProgress({ label, done: want, total: want });
  return { songs, plan: next, note: null };
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

// ---- Listing playlists ----

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
      name: p.name || msg().errors.untitledPlaylist,
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

