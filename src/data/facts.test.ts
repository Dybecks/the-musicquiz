import { describe, expect, it } from 'vitest';
import { FACT_ROWS, writtenFact } from './facts';
import { DEFAULT_SONGS } from './songs';
import { GAME_SONGS, MOVIE_SONGS, MUSICAL_SONGS, TV_SONGS } from './soundtracks';

const ALL = [...DEFAULT_SONGS, ...MOVIE_SONGS, ...MUSICAL_SONGS, ...TV_SONGS, ...GAME_SONGS];

describe('written facts', () => {
  it('every fact belongs to a song in a built-in deck', () => {
    const songs = new Set(ALL.map((s) => `${s.title} / ${s.artist}`));
    const orphans = FACT_ROWS.map(([title, artist]) => `${title} / ${artist}`).filter((k) => !songs.has(k));
    expect(orphans).toEqual([]);
  });

  it('has at most one fact per song', () => {
    const keys = FACT_ROWS.map(([title, artist]) => `${title} / ${artist}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('keeps facts short and tidy', () => {
    for (const [title, , fact] of FACT_ROWS) {
      expect(fact.length, title).toBeLessThanOrEqual(240);
      expect(fact, title).toMatch(/^[A-Z"'(0-9]/);
      expect(fact, title).toMatch(/[.!?"]$/);
    }
  });

  it('finds facts by title and artist', () => {
    expect(writtenFact({ title: 'Waterloo', artist: 'ABBA' })).toMatch(/Eurovision/);
    expect(writtenFact({ title: 'Waterloo', artist: 'Someone Else' })).toBeUndefined();
  });
});
