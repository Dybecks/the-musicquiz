import { describe, expect, it } from 'vitest';
import type { Song } from '../game/engine';
import { filterSongs, genresFromSpotify, personalPresets, STANDARD_PRESETS } from './genres';
import { DEFAULT_SONGS } from './songs';

const song = (year: number, genres?: Song['genres']): Song => ({ id: `s${year}${genres?.join()}`, title: 't', artist: 'a', year, genres });

describe('genresFromSpotify', () => {
  it('folds Spotify genres into the game genres', () => {
    expect(genresFromSpotify(['album rock', 'classic rock'])).toEqual(['rock']);
    expect(genresFromSpotify(['swedish pop', 'eurodance'])).toEqual(['pop', 'dance', 'swedish']);
    expect(genresFromSpotify(['atl hip hop', 'southern hip hop'])).toEqual(['hiphop']);
    expect(genresFromSpotify(['disco', 'funk'])).toEqual(['soul']);
    expect(genresFromSpotify([])).toEqual([]);
  });
});

describe('filterSongs', () => {
  const songs = [song(1965, ['rock']), song(1985, ['pop', 'dance']), song(2005, ['hiphop']), song(1990)];
  it('keeps everything without a filter', () => {
    expect(filterSongs(songs, { genres: [], fromYear: null, toYear: null })).toHaveLength(4);
  });
  it('filters by year span, inclusive', () => {
    expect(filterSongs(songs, { genres: [], fromYear: 1985, toYear: 2005 }).map((s) => s.year)).toEqual([1985, 2005, 1990]);
  });
  it('keeps songs with any chosen genre and drops unknown ones', () => {
    expect(filterSongs(songs, { genres: ['dance', 'rock'], fromYear: null, toYear: null }).map((s) => s.year)).toEqual([1965, 1985]);
  });
});

describe('presets', () => {
  it('every standard preset leaves enough classic songs for a game', () => {
    for (const p of STANDARD_PRESETS) expect(filterSongs(DEFAULT_SONGS, p.filter).length, p.id).toBeGreaterThanOrEqual(10);
  });
  it('every classic song has a genre', () => {
    expect(DEFAULT_SONGS.filter((s) => !s.genres?.length)).toEqual([]);
  });
  it('builds "your era" and "your genres" from someone’s music', () => {
    const mine = [
      ...Array.from({ length: 16 }, (_, i) => song(2000 + i, ['pop'])),
      ...Array.from({ length: 4 }, (_, i) => song(1970 + i, ['rock'])),
    ];
    const presets = personalPresets(mine);
    const era = presets.find((p) => p.id === 'my-era')!;
    expect(era.filter.fromYear).toBeGreaterThanOrEqual(1970);
    expect(era.filter.toYear).toBe(2013); // 90th percentile
    expect(presets.find((p) => p.id === 'my-genres')?.filter.genres).toEqual(['pop', 'rock']);
  });
  it('gives no personal presets for very few songs', () => {
    expect(personalPresets([song(2000, ['pop'])])).toEqual([]);
  });
});
