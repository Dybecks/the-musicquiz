/**
 * Reads what a logged-in person listens to on Spotify and turns it into a
 * song deck. Only runs after the person has chosen which data to share and
 * granted the matching permissions. The result is kept in this browser only.
 */
import type { Song } from '../game/engine';
import { spotifyGet } from './api';
import { filterSongs, genresFromSpotify, isFiltered, NO_FILTER, type DeckFilter, type Genre } from '../data/genres';
import {
  SOURCE_SCOPES,
  couldMatchYears,
  earliestYear,
  releaseYear,
  trackToSong,
  uniqueTracks,
  type Contributor,
  type ListeningSource,
  type PersonalDeck,
  type SpotifyTrack,
} from './personalDeck';

const DECK_KEY = 'mq.personalDeck';
const SOURCES_KEY = 'mq.personalSources';

/** Spotify allows at most this many tracks per page of these endpoints. */
const PAGE = 50;
/** Liked songs: how many pages to read at most, without and with a genre or year filter. */
const LIKED_PAGES = 4;
const LIKED_PAGES_FILTERED = 10;
/** Upper bound on cards, which also bounds the number of year lookups. */
const MAX_TRACKS = 300;
/** Year lookups run this many at a time. */
const CONCURRENCY = 4;

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

/**
 * Adds or replaces one person's music. Phase one keeps a single contributor;
 * a later multi-player version can keep several here.
 */
export function savePersonalDeck(contributor: Contributor): PersonalDeck {
  const deck: PersonalDeck = { version: 1, contributors: [contributor] };
  localStorage.setItem(DECK_KEY, JSON.stringify(deck));
  return deck;
}

export function forgetPersonalDeck(): void {
  localStorage.removeItem(DECK_KEY);
}

interface Paged<T> {
  items: T[];
  next: string | null;
}

async function topTracks(): Promise<SpotifyTrack[]> {
  const out: SpotifyTrack[] = [];
  // Long term first: those are the songs someone really knows.
  for (const range of ['long_term', 'medium_term', 'short_term']) {
    const page = await spotifyGet<Paged<SpotifyTrack>>(`/me/top/tracks?time_range=${range}&limit=${PAGE}`);
    out.push(...page.items);
  }
  return out;
}

async function recentTracks(): Promise<SpotifyTrack[]> {
  const page = await spotifyGet<Paged<{ track: SpotifyTrack }>>(`/me/player/recently-played?limit=${PAGE}`);
  return page.items.map((i) => i.track);
}

async function likedTracks(pages: number): Promise<SpotifyTrack[]> {
  const out: SpotifyTrack[] = [];
  for (let i = 0; i < pages; i++) {
    const page = await spotifyGet<Paged<{ track: SpotifyTrack }>>(`/me/tracks?limit=${PAGE}&offset=${i * PAGE}`);
    out.push(...page.items.map((item) => item.track));
    if (!page.next) break;
  }
  return out;
}

const READERS: Record<ListeningSource, (filtered: boolean) => Promise<SpotifyTrack[]>> = {
  top: topTracks,
  recent: recentTracks,
  // With a filter many liked songs are left out, so read further back.
  liked: (filtered) => likedTracks(filtered ? LIKED_PAGES_FILTERED : LIKED_PAGES),
};

async function originalYear(track: SpotifyTrack & { id: string }): Promise<number | null> {
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
 * lookups (genres, original years) skip songs that can't match it, so the
 * card limit is spent on songs that will actually be played.
 */
export async function gatherListening(
  sources: ListeningSource[],
  filter: DeckFilter = NO_FILTER,
  onProgress: (p: GatherProgress) => void = () => {},
): Promise<GatherResult> {
  const failures: GatherResult['failures'] = [];
  const raw: SpotifyTrack[] = [];
  let read = 0;
  for (const source of sources) {
    onProgress({ step: 'reading', done: read, total: sources.length });
    try {
      raw.push(...(await READERS[source](isFiltered(filter))));
    } catch (e) {
      failures.push({ source, message: e instanceof Error ? e.message : String(e) });
    }
    read++;
  }

  let candidates = uniqueTracks(raw).filter((t) => couldMatchYears(t, filter));
  // Without a genre choice, genres are only extra information, so look them
  // up for the songs that are kept. With one, look them up first and drop
  // songs from other genres before dating anything.
  if (filter.genres.length === 0) candidates = candidates.slice(0, MAX_TRACKS);
  // Genres come from the song's main artist. Spotify may return no genres
  // for some artists (or none at all for some apps); those songs simply
  // have no genre and are left out when the host filters by genre.
  const genres = await artistGenres([...new Set(candidates.map((t) => t.artists[0].id))], onProgress);
  const genresOf = (t: SpotifyTrack) => genres.get(t.artists[0].id) ?? [];
  const tracks = candidates
    .filter((t) => filter.genres.length === 0 || genresOf(t).some((g) => filter.genres.includes(g)))
    .slice(0, MAX_TRACKS);

  const songs: (Song | null)[] = new Array(tracks.length).fill(null);
  let next = 0;
  let done = 0;
  onProgress({ step: 'dating', done, total: tracks.length });
  const worker = async () => {
    while (next < tracks.length) {
      const i = next++;
      const year = await originalYear(tracks[i]);
      if (year !== null) {
        const song = trackToSong(tracks[i], year);
        const g = genresOf(tracks[i]);
        if (g.length) song.genres = g;
        songs[i] = song;
      }
      onProgress({ step: 'dating', done: ++done, total: tracks.length });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const dated = songs.filter((s): s is Song => s !== null);
  return { songs: filterSongs(dated, filter), failures };
}

async function artistGenres(ids: string[], onProgress: (p: GatherProgress) => void): Promise<Map<string, Genre[]>> {
  const out = new Map<string, Genre[]>();
  let next = 0;
  let done = 0;
  let failuresInARow = 0;
  onProgress({ step: 'genres', done, total: ids.length });
  const worker = async () => {
    // Stop early if the endpoint isn't available to this app at all.
    while (next < ids.length && failuresInARow < 5) {
      const id = ids[next++];
      try {
        const artist = await spotifyGet<{ genres?: string[] }>(`/artists/${encodeURIComponent(id)}`);
        out.set(id, genresFromSpotify(artist.genres ?? []));
        failuresInARow = 0;
      } catch {
        failuresInARow++;
      }
      onProgress({ step: 'genres', done: ++done, total: ids.length });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}
