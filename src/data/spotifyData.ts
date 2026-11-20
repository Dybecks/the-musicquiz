/**
 * Spotify data the game ships with, filled in by scripts/spotify-precompute.ts
 * (run on GitHub, see .github/workflows/spotify-data.yml). With it, songs play
 * in the hidden Spotify player and genre lists are built without a single
 * Spotify request.
 */
import type { Song } from '../game/engine';
import TRACK_IDS from './spotify/track-ids.json';
import { SEARCH_GENRE_DEFS as SEARCH_GENRES } from './searchGenres';

/** How a ready-made song is found in track-ids.json. */
export const premadeKey = (song: Pick<Song, 'title' | 'artist'>) => `${song.title}|${song.artist}`;

const ids = TRACK_IDS as Record<string, string>;

/** Adds the looked-up Spotify id to a ready-made song that has none pinned. */
export function withTrackId<T extends Song>(song: T): T {
  if (song.spotifyId) return song;
  const id = ids[premadeKey(song)];
  return id ? { ...song, spotifyId: id } : song;
}

/** One song in a genre list: title, artist(s), original year, Spotify track id. */
export type PoolRow = [title: string, artist: string, year: number, spotifyId: string];
/** Songs per genre id (the ids of SEARCH_GENRES). */
export type GenrePools = Record<string, PoolRow[]>;

let poolsPromise: Promise<GenrePools> | null = null;

/** The genre lists are only loaded when someone builds a list by genre. */
export function loadGenrePools(): Promise<GenrePools> {
  poolsPromise ??= import('./spotify/genre-pools.json').then((m) => m.default as unknown as GenrePools);
  return poolsPromise;
}

/** The songs from the game's own genre lists for these genres and years. */
export function poolSongs(pools: GenrePools, genreIds: readonly string[], from: number, to: number): Song[] {
  const out: Song[] = [];
  for (const g of SEARCH_GENRES) {
    if (!genreIds.includes(g.id)) continue;
    for (const [title, artist, year, spotifyId] of pools[g.id] ?? []) {
      if (year < from || year > to) continue;
      out.push({ id: `sp:${spotifyId}`, title, artist, year, spotifyId, ...(g.genre ? { genres: [g.genre] } : {}) });
    }
  }
  return out;
}
