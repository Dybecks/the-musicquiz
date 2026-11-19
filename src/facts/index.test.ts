import { describe, expect, it, vi } from 'vitest';
import type { Song } from '../game/engine';
import { loadFact } from '.';

const song = (id: string, title: string, artist: string): Song => ({ id, title, artist, year: 2000 });

describe('loadFact', () => {
  it('uses the written fact without looking anything up', async () => {
    const lookup = vi.fn();
    const fact = await loadFact(song('t1', 'Waterloo', 'ABBA'), lookup);
    expect(fact?.text).toMatch(/Eurovision/);
    expect(fact?.url).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('falls back to the lookup, once per song', async () => {
    const lookup = vi.fn(async () => ({ text: 'From Wikipedia.', about: 'song' as const, url: 'https://x' }));
    const s = song('t2', 'Some Personal Song', 'Someone');
    await loadFact(s, lookup);
    const fact = await loadFact(s, lookup);
    expect(fact?.text).toBe('From Wikipedia.');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('treats a failed lookup as no fact', async () => {
    const fact = await loadFact(song('t3', 'X', 'Y'), async () => {
      throw new Error('offline');
    });
    expect(fact).toBeNull();
  });
});
