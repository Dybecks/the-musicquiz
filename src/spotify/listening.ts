/**
 * The host's own song lists. "By genre" picks from the game's own song
 * catalogue (no Spotify requests at all); "From my playlists" reads the
 * playlists the host picks (one request lists them all). The result is kept
 * in this browser only.
 */
import type { Song } from '../game/engine';
import { RateLimitError, spotifyGet, SpotifyError } from './api';
import { msg } from '../i18n';
import { SEARCH_GENRE_DEFS, type SearchGenre } from '../data/searchGenres';
import { catalogSongs } from '../data/catalog';
import {
  earliestYear,
  needsYearCheck,
  releaseYear,
  trackToSong,
  uniqueTracks,
  withContributor,
  type Contributor,
  type PersonalDeck,
  type SpotifyTrack,
} from './personalDeck';

const DECK_KEY = 'mq.personalDeck';
const CACHE_KEY = 'mq.spotifyCache';

/** How many genres can be picked at once. */
export const MAX_GENRES = 4;
/** Playlists listed per request (Spotify's maximum). */
const PLAYLIST_PAGE = 50;
/** Tracks per playlist request: one batch. */
const TRACK_PAGE = 50;
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
export const SEARCH_GENRES: { id: string; readonly label: string; genre?: SearchGenre['genre'] }[] = SEARCH_GENRE_DEFS.map((g) => ({
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
 * Where a playlist list's songs come from. The game fetches one batch to
 * start with and another whenever its deck runs low, so a game only costs
 * the requests it actually needs. Each batch is a random part of a random
 * chosen playlist. Pages already fetched are remembered and not fetched
 * again. Plain JSON, so it is saved with the game.
 */
export type RefillPlan = { kind: 'playlists'; playlists: Pick<PlaylistSummary, 'id' | 'name' | 'tracks'>[]; asked: Record<string, number[]> };

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

/**
 * A genre list: every song in the game's catalogue (src/data/catalog) tagged
 * with one of the genres, from those years. They all have a Spotify id, so
 * building the list and playing it costs no Spotify requests.
 */
export function genreSongs(genreIds: readonly string[], from: number, to: number): Song[] {
  return mergeById(catalogSongs(genreIds, Math.min(from, to), Math.max(from, to)));
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

/**
 * Fetches the next batch of songs for a list. A game saved by an earlier
 * version may still hold a genre plan: it gets no more songs.
 */
export function fetchBatch(plan: RefillPlan): Promise<Batch> {
  return plan.kind === 'playlists' ? playlistBatch(plan) : Promise.resolve({ songs: [], plan: null });
}

/** Fetches the first few songs, one batch (request) after another, until there are enough to start. */
export async function startList(
  plan: RefillPlan,
  onProgress: (p: BuildProgress) => void = () => {},
  want = FIRST_BATCH,
): Promise<{ songs: Song[]; plan: RefillPlan | null; note: string | null }> {
  let songs: Song[] = [];
  let next: RefillPlan | null = plan;
  let tries = 0;
  const label = msg().errors.readingPlaylists;
  while (next && (tries === 0 || songs.length < want) && tries < 5) {
    onProgress({ label, done: Math.min(songs.length, want), total: want });
    try {
      const batch = await fetchBatch(next);
      songs = mergeById([...songs, ...batch.songs]);
      next = batch.plan;
    } catch (e) {
      if (songs.length) break;
      throw e;
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

