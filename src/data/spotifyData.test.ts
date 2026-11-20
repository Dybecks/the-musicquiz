import { describe, expect, it } from 'vitest';
import TRACK_IDS from './spotify/track-ids.json';
import POOLS from './spotify/genre-pools.json';
import { poolSongs, premadeKey, withTrackId, type GenrePools } from './spotifyData';
import { SEARCH_GENRE_DEFS as SEARCH_GENRES } from './searchGenres';
import { DEFAULT_SONGS } from './songs';
import { GAME_SONGS, MOVIE_SONGS, MUSICAL_SONGS, TV_SONGS } from './soundtracks';

const SPOTIFY_ID = /^[0-9A-Za-z]{22}$/;
const ALL_PREMADE = [...DEFAULT_SONGS, ...MOVIE_SONGS, ...MUSICAL_SONGS, ...TV_SONGS, ...GAME_SONGS];

describe('track-ids.json', () => {
  const ids = TRACK_IDS as Record<string, string>;
  it('holds Spotify track ids for songs in the ready-made decks', () => {
    const keys = new Set(ALL_PREMADE.map(premadeKey));
    for (const [key, id] of Object.entries(ids)) {
      expect(id, key).toMatch(SPOTIFY_ID);
      expect(keys.has(key), `${key} is in no deck`).toBe(true);
    }
  });
  it('is applied to the decks', () => {
    for (const s of ALL_PREMADE) if (ids[premadeKey(s)]) expect(s.spotifyId).toBeTruthy();
  });
});

describe('genre-pools.json', () => {
  const pools = POOLS as unknown as GenrePools;
  it('only has genres the game offers, with valid rows', () => {
    const known = new Set(SEARCH_GENRES.map((g) => g.id));
    for (const [genre, rows] of Object.entries(pools)) {
      expect(known.has(genre), genre).toBe(true);
      for (const [title, artist, year, id] of rows) {
        expect(title.trim(), `${genre}: ${artist}`).not.toBe('');
        expect(artist.trim(), `${genre}: ${title}`).not.toBe('');
        expect(year, `${genre}: ${title}`).toBeGreaterThanOrEqual(1900);
        expect(year, `${genre}: ${title}`).toBeLessThanOrEqual(new Date().getFullYear());
        expect(id, `${genre}: ${title}`).toMatch(SPOTIFY_ID);
      }
    }
  });
});

describe('poolSongs', () => {
  const pools: GenrePools = {
    rock: [
      ['Song A', 'Band', 1975, '0000000000000000000001'],
      ['Song B', 'Band', 1995, '0000000000000000000002'],
    ],
    country: [['Song C', 'Singer', 1980, '0000000000000000000003']],
  };
  it('keeps the chosen genres and years, with the wider genre for filtering', () => {
    const songs = poolSongs(pools, ['rock', 'country'], 1970, 1989);
    expect(songs.map((s) => s.title)).toEqual(['Song A', 'Song C']);
    expect(songs[0]).toMatchObject({ year: 1975, spotifyId: '0000000000000000000001', genres: ['rock'] });
    expect(songs[1].genres).toBeUndefined();
  });
  it('is empty for genres with no list yet', () => expect(poolSongs({}, ['pop'], 1950, 2030)).toEqual([]));
});

describe('withTrackId', () => {
  it('keeps an id pinned by hand', () => {
    const s = { id: 'x', title: 't', artist: 'a', year: 2000, spotifyId: 'pinned' };
    expect(withTrackId(s)).toBe(s);
  });
});
