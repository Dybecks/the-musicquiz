import { writtenFact } from '../data/facts';
import type { Song } from '../game/engine';
import { findFact, type SongFact } from './wikipedia';

export type { SongFact };

/**
 * The fun fact for the reveal screen: the one written for the song's deck
 * (src/data/facts.ts) when there is one, else a live Wikipedia lookup.
 *
 * Cached per song for the session. Errors (offline, rate limited) are cached as
 * "no fact" too, so a failing lookup isn't retried on every render.
 */
const cache = new Map<string, Promise<SongFact | null>>();

export function loadFact(song: Song, lookup: (song: Song) => Promise<SongFact | null> = findFact): Promise<SongFact | null> {
  let hit = cache.get(song.id);
  if (!hit) {
    const written = writtenFact(song);
    hit = written ? Promise.resolve({ text: written, about: 'song' as const }) : lookup(song).catch(() => null);
    cache.set(song.id, hit);
  }
  return hit;
}
