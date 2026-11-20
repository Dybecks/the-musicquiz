import { writtenFact } from '../data/facts';
import type { Song } from '../game/engine';
import { getLang, type Lang } from '../i18n';
import { findFact, type SongFact } from './wikipedia';

export type { SongFact };

/**
 * The fun fact for the reveal screen: the one written for the song's deck
 * (src/data/facts.ts, in Swedish src/data/facts.sv.ts) when there is one,
 * else a live lookup on Wikipedia in the game's language.
 *
 * Cached per song and language for the session. Errors (offline, rate limited) are cached as
 * "no fact" too, so a failing lookup isn't retried on every render.
 */
const cache = new Map<string, Promise<SongFact | null>>();

export function loadFact(
  song: Song,
  lookup: (song: Song, lang: Lang) => Promise<SongFact | null> = (s, lang) => findFact(s, undefined, lang),
): Promise<SongFact | null> {
  const lang = getLang();
  const key = `${lang}:${song.id}`;
  let hit = cache.get(key);
  if (!hit) {
    const written = writtenFact(song, lang);
    hit = written ? Promise.resolve({ text: written, about: 'song' as const }) : lookup(song, lang).catch(() => null);
    cache.set(key, hit);
  }
  return hit;
}
