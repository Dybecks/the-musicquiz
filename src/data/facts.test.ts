import { describe, expect, it } from 'vitest';
import { FACT_ROWS, writtenFact } from './facts';
import { FACTS_SV } from './facts.sv';
import { CATALOG_ROWS as ALL } from './catalog';
import CANDIDATES from '../../scripts/candidates.json';

describe('written facts', () => {
  // A song whose Spotify id turned out wrong waits in scripts/candidates.json; its fact waits with it.
  it('every fact belongs to a song in the catalogue or among the candidates', () => {
    const songs = new Set([...ALL, ...CANDIDATES].map((s) => `${s.title} / ${s.artist}`));
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

  it('has every fact in Swedish too, and nothing else', () => {
    const key = ([title, artist]: readonly string[]) => `${title} / ${artist}`;
    const english = FACT_ROWS.map(key);
    const swedish = FACTS_SV.map(key);
    expect(english.filter((k) => !swedish.includes(k)), 'missing in facts.sv.ts').toEqual([]);
    expect(swedish.filter((k) => !english.includes(k)), 'not in facts.ts').toEqual([]);
    expect(swedish.filter((k, i) => swedish.indexOf(k) !== i), 'twice in facts.sv.ts').toEqual([]);
    for (const [title, , fact] of FACTS_SV) {
      expect(fact.length, title).toBeLessThanOrEqual(240);
      expect(fact, title).toMatch(/^[A-ZÅÄÖ”'(0-9.]/);
      expect(fact, title).toMatch(/[.!?”]$/);
    }
  });

  it('finds the Swedish fact in Swedish', () => {
    expect(writtenFact({ title: 'Waterloo', artist: 'ABBA' }, 'sv')).toMatch(/Sveriges första seger/);
  });
});
