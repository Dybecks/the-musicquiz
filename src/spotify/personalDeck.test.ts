import { describe, expect, it } from 'vitest';
import {
  cleanTitle,
  friendContributors,
  hostContributor,
  needsYearCheck,
  spreadPick,
  withContributor,
  withoutContributor,
  type Contributor,
  couldMatchYears,
  earliestYear,
  mergeSongs,
  releaseYear,
  songKey,
  songsFromSearch,
  yearSlices,
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

describe('couldMatchYears', () => {
  it('drops only tracks whose album is older than the span', () => {
    const from80 = { fromYear: 1980 };
    expect(couldMatchYears(track('a', 'Song', '1975'), from80)).toBe(false);
    // A 2011 remaster could still be a song from the 80s.
    expect(couldMatchYears(track('b', 'Song', '2011'), from80)).toBe(true);
    expect(couldMatchYears(track('c', 'Song', ''), from80)).toBe(true);
    expect(couldMatchYears(track('d', 'Song', '1975'), { fromYear: null })).toBe(true);
  });
});

describe('needsYearCheck', () => {
  const t = (name: string, album: string, album_type = 'album'): SpotifyTrack => ({
    id: 'x',
    name,
    artists: [{ id: 'a', name: 'A' }],
    album: { name: album, album_type, release_date: '2011' },
  });
  it('trusts songs on their original album', () => expect(needsYearCheck(t('Bohemian Rhapsody', 'A Night at the Opera'))).toBe(false));
  it('checks reissues, compilations and edited titles', () => {
    expect(needsYearCheck(t('Bohemian Rhapsody', 'A Night at the Opera (2011 Remaster)'))).toBe(true);
    expect(needsYearCheck(t('Bohemian Rhapsody', 'Greatest Hits'))).toBe(true);
    expect(needsYearCheck(t('Bohemian Rhapsody', 'Now 80s', 'compilation'))).toBe(true);
    expect(needsYearCheck(t('Bohemian Rhapsody - Remastered 2011', 'A Night at the Opera'))).toBe(true);
  });
});

describe('spreadPick', () => {
  it('takes from every decade in turn when there are too many', () => {
    const years = [2020, 2021, 2022, 2023, 2024, 2025, 1975, 1985];
    expect(spreadPick(years, 4, (y) => y)).toEqual([2020, 1975, 1985, 2021]);
  });
  it('keeps everything when under the limit', () => expect(spreadPick([1, 2], 5, () => null)).toEqual([1, 2]));
});

describe('contributors', () => {
  const person = (userId: string, role?: Contributor['role']): Contributor => ({
    role,
    userId,
    name: userId,
    sources: ['top'],
    builtAt: '',
    songs: [],
  });
  it('keeps one host and adds friends', () => {
    let deck = withContributor(null, person('host'));
    deck = withContributor(deck, person('anna', 'friend'));
    deck = withContributor(deck, person('bo', 'friend'));
    deck = withContributor(deck, person('anna', 'friend')); // reloaded, not duplicated
    expect(deck.contributors.map((c) => c.userId)).toEqual(['host', 'bo', 'anna']);
    // A new host replaces the old one, friends stay.
    deck = withContributor(deck, person('host2', 'host'));
    expect(hostContributor(deck)?.userId).toBe('host2');
    expect(friendContributors(deck).map((c) => c.userId)).toEqual(['bo', 'anna']);
    expect(withoutContributor(deck, 'bo')?.contributors.map((c) => c.userId)).toEqual(['host2', 'anna']);
    expect(withoutContributor(withContributor(null, person('x')), 'x')).toBeNull();
  });
});

describe('yearSlices', () => {
  it('searches each decade on its own when few genres are chosen', () => {
    expect(yearSlices(1975, 1999, 2)).toEqual([
      { from: 1975, to: 1979 },
      { from: 1980, to: 1989 },
      { from: 1990, to: 1999 },
    ]);
  });
  it('joins decades so genres × slices stays within the cap', () => {
    const slices = yearSlices(1950, 2026, 4, 12);
    expect(slices).toHaveLength(3);
    expect(slices[0].from).toBe(1950);
    expect(slices[2].to).toBe(2026);
    for (let i = 1; i < slices.length; i++) expect(slices[i].from).toBe(slices[i - 1].to + 1);
  });
  it('handles a single year and reversed input', () => {
    expect(yearSlices(1985, 1985, 1)).toEqual([{ from: 1985, to: 1985 }]);
    expect(yearSlices(1999, 1990, 1)).toEqual([{ from: 1990, to: 1999 }]);
  });
});

describe('songsFromSearch', () => {
  it('keeps songs on their original album inside the years, and skips reissues', () => {
    const songs = songsFromSearch(
      [
        track('a', 'Take On Me', '1985-04-01'),
        { ...track('b', 'Dancing Queen', '1992-01-01'), album: { name: 'ABBA Gold', album_type: 'compilation', release_date: '1992-01-01' } },
        track('c', 'Under Pressure - Remastered 2011', '1985'),
        track('d', 'Too Late', '2001'),
        null,
      ],
      { from: 1980, to: 1989 },
    );
    expect(songs.map((s) => [s.spotifyId, s.year])).toEqual([['a', 1985]]);
  });
});
