import { describe, expect, it } from 'vitest';
import { CATALOG, CATALOG_ROWS, DECK_LISTS, catalogSongs, widerGenres } from './catalog';
import { SEARCH_GENRE_DEFS } from './searchGenres';
import { songKey } from '../spotify/personalDeck';

const SPOTIFY_ID = /^[0-9A-Za-z]{22}$/;

describe('the song catalogue', () => {
  it('has valid rows', () => {
    const genres = new Set(SEARCH_GENRE_DEFS.map((g) => g.id));
    for (const r of CATALOG_ROWS) {
      const name = `${r.title} – ${r.artist}`;
      expect(r.title.trim(), name).not.toBe('');
      expect(r.artist.trim(), name).not.toBe('');
      expect(r.year, name).toBeGreaterThanOrEqual(1900);
      expect(r.year, name).toBeLessThanOrEqual(new Date().getFullYear());
      if (r.id !== null) expect(r.id, name).toMatch(SPOTIFY_ID);
      for (const g of r.genres) expect(genres.has(g), `${name}: ${g}`).toBe(true);
    }
  });

  it('has each song and each Spotify id once', () => {
    const keys = CATALOG_ROWS.map((r) => songKey(r.title, r.artist));
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    const ids = CATALOG_ROWS.flatMap((r) => (r.id ? [r.id] : []));
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it('only plays songs with a Spotify id', () => {
    expect(CATALOG.length).toBe(CATALOG_ROWS.filter((r) => r.id).length);
    expect(CATALOG.every((s) => s.id === `sp:${s.spotifyId}`)).toBe(true);
  });
});

describe('ready-made decks', () => {
  it('only list songs in the catalogue that have a Spotify id', () => {
    const known = new Set(CATALOG.map((s) => s.spotifyId));
    for (const [deck, ids] of Object.entries(DECK_LISTS)) {
      const missing = ids.filter((id) => !known.has(id));
      expect(missing, `${deck}: not in the catalogue`).toEqual([]);
      expect(new Set(ids).size, `${deck}: repeats`).toBe(ids.length);
    }
  });
});

describe('catalogSongs', () => {
  it('keeps the chosen genres and years', () => {
    const songs = catalogSongs(['rock', 'country'], 1970, 1989);
    expect(songs.length).toBeGreaterThan(10);
    for (const s of songs) {
      expect(s.year).toBeGreaterThanOrEqual(1970);
      expect(s.year).toBeLessThanOrEqual(1989);
      const row = CATALOG_ROWS.find((r) => r.id === s.spotifyId)!;
      expect(row.genres.some((g) => g === 'rock' || g === 'country'), s.title).toBe(true);
    }
  });
  it('is empty without genres', () => expect(catalogSongs([], 1900, 2100)).toEqual([]));
});

describe('widerGenres', () => {
  it('maps catalogue genres to the filter genres', () => {
    expect(widerGenres(['metal', 'rock', 'country', 'schlager'])).toEqual(['rock', 'swedish']);
  });
});
