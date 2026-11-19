import { describe, expect, it } from 'vitest';
import {
  cleanTitle,
  earliestYear,
  mergeSongs,
  releaseYear,
  songKey,
  summarize,
  trackToSong,
  uniqueTracks,
  type SpotifyTrack,
} from './personalDeck';

const track = (id: string, name: string, date: string, artistId = 'queen', artist = 'Queen'): SpotifyTrack => ({
  id,
  name,
  artists: [{ id: artistId, name: artist }],
  album: { release_date: date },
});

describe('cleanTitle', () => {
  it('strips remaster and edit suffixes', () => {
    expect(cleanTitle('Bohemian Rhapsody - Remastered 2011')).toBe('Bohemian Rhapsody');
    expect(cleanTitle('Wonderwall - Remastered')).toBe('Wonderwall');
    expect(cleanTitle('Africa (2018 Remaster)')).toBe('Africa');
    expect(cleanTitle('Rain - Radio Edit')).toBe('Rain');
    expect(cleanTitle('Señorita (feat. Someone)')).toBe('Señorita');
  });
  it('keeps titles that only look like suffixes', () => {
    expect(cleanTitle("(I Can't Get No) Satisfaction")).toBe("(I Can't Get No) Satisfaction");
    expect(cleanTitle('Hey - Ho')).toBe('Hey - Ho');
  });
});

describe('releaseYear', () => {
  it('reads year, month and day precision', () => {
    expect(releaseYear('1975')).toBe(1975);
    expect(releaseYear('1975-10-31')).toBe(1975);
  });
  it('rejects missing or impossible years', () => {
    expect(releaseYear('0000')).toBeNull();
    expect(releaseYear(undefined)).toBeNull();
    expect(releaseYear('2999-01-01', new Date('2026-01-01'))).toBeNull();
  });
});

describe('earliestYear', () => {
  const remaster = track('a', 'Bohemian Rhapsody - Remastered 2011', '2011-01-01');
  it('uses the earliest matching release by the same artist', () => {
    const candidates = [
      track('b', 'Bohemian Rhapsody', '1975-10-31'),
      track('c', 'Bohemian Rhapsody', '1981-01-01'),
      track('d', 'Bohemian Rhapsody', '1970-01-01', 'other', 'A Cover Band'),
      track('e', 'Bohemian Rhapsody Medley', '1960-01-01'),
    ];
    expect(earliestYear(remaster, candidates)).toBe(1975);
  });
  it('falls back to the album year', () => expect(earliestYear(remaster, [])).toBe(2011));
});

describe('uniqueTracks', () => {
  it('drops local files, repeats and other releases of the same song', () => {
    const local = { ...track('l', 'Demo', '2020'), is_local: true };
    const out = uniqueTracks([
      track('a', 'Bohemian Rhapsody', '1975'),
      track('a', 'Bohemian Rhapsody', '1975'),
      track('b', 'Bohemian Rhapsody - Remastered 2011', '2011'),
      local,
      null,
      track('c', 'Under Pressure', '1981'),
    ]);
    expect(out.map((t) => t.id)).toEqual(['a', 'c']);
  });
});

describe('trackToSong and mergeSongs', () => {
  it('builds a playable card and merges decks without duplicates', () => {
    const mine = trackToSong({ ...track('id1', 'Under Pressure - Remastered 2011', '2011'), id: 'id1' }, 1981);
    expect(mine).toEqual({ id: 'sp:id1', title: 'Under Pressure', artist: 'Queen', year: 1981, spotifyId: 'id1' });
    const classic = [
      { id: 'd1', title: 'Under Pressure', artist: 'Queen & David Bowie', year: 1981 },
      { id: 'd2', title: 'Imagine', artist: 'John Lennon', year: 1971 },
    ];
    expect(mergeSongs([mine], classic).map((s) => s.id)).toEqual(['sp:id1', 'd2']);
    expect(songKey('Under Pressure', 'Queen & David Bowie')).toBe(songKey('Under Pressure - Remastered', 'Queen'));
  });
});

describe('summarize', () => {
  it('counts songs per decade', () => {
    const s = summarize([1975, 1979, 1981, 2023].map((year, i) => ({ id: `${i}`, title: 't', artist: 'a', year })));
    expect(s).toEqual({ count: 4, minYear: 1975, maxYear: 2023, decades: [[1970, 2], [1980, 1], [2020, 1]] });
  });
});
