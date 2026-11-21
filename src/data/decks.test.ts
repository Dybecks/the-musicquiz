import { describe, expect, it } from 'vitest';
import { chooseSongs, deckSongs, normalizeDecks, parseSavedDecks } from './decks';
import { DEFAULT_SONGS, NO_LOGIN_SONGS } from './songs';
import { GAME_SONGS, MOVIE_SONGS, MUSICAL_SONGS, TV_SONGS } from './soundtracks';
import { mergeSongs, songKey, type PersonalDeck } from '../spotify/personalDeck';

const soundtracks = { movies: MOVIE_SONGS, musicals: MUSICAL_SONGS, tv: TV_SONGS, games: GAME_SONGS };

describe('soundtrack decks', () => {
  for (const [name, songs] of Object.entries(soundtracks)) {
    describe(name, () => {
      it('has at least 30 songs', () => expect(songs.length).toBeGreaterThanOrEqual(30));
      it('says where every song is from, with a plausible year', () => {
        for (const s of songs) {
          expect(s.from, s.title).toBeTruthy();
          expect(s.year, s.title).toBeGreaterThanOrEqual(1930);
          expect(s.year, s.title).toBeLessThanOrEqual(new Date().getFullYear());
        }
      });
      it('is ordered by year and has no repeats', () => {
        const years = songs.map((s) => s.year);
        expect(years).toEqual([...years].sort((a, b) => a - b));
        expect(new Set(songs.map((s) => songKey(s.title, s.artist))).size).toBe(songs.length);
        expect(new Set(songs.map((s) => s.id)).size).toBe(songs.length);
      });
    });
  }

  it('do not repeat the classic deck or each other', () => {
    const all = [DEFAULT_SONGS, ...Object.values(soundtracks)];
    expect(mergeSongs(...all)).toHaveLength(all.reduce((n, l) => n + l.length, 0));
  });
});

describe('deck choice', () => {
  it('reads choices saved by earlier versions', () => {
    expect(parseSavedDecks('mix')).toEqual(['classic', 'mine']);
    expect(parseSavedDecks('mine')).toEqual(['mine']);
    expect(parseSavedDecks(null)).toEqual(['classic']);
    expect(parseSavedDecks('["tv","movies","nope"]')).toEqual(['movies', 'tv']);
    expect(normalizeDecks([])).toEqual(['classic']);
  });

  it('combines decks', () => {
    const songs = chooseSongs({ decks: ['movies', 'tv'], mode: 'premium', loggedIn: true, personal: null });
    expect(songs).toHaveLength(MOVIE_SONGS.length + TV_SONGS.length);
  });

  it('only keeps songs with a Spotify id for the hidden player without login', () => {
    const songs = chooseSongs({ decks: ['classic', 'games'], mode: 'embed', loggedIn: false, personal: null });
    expect(songs.length).toBeGreaterThanOrEqual(NO_LOGIN_SONGS.length);
    expect(songs.every((s) => s.spotifyId)).toBe(true);
    expect(songs.slice(0, NO_LOGIN_SONGS.length)).toEqual(NO_LOGIN_SONGS);
  });

  it("puts the person's own copy of a song first", () => {
    const personal: PersonalDeck = {
      version: 1,
      contributors: [
        {
          userId: 'u',
          name: 'U',
          sources: ['top'],
          builtAt: '',
          songs: [{ id: 'sp:1', title: 'Let It Go', artist: 'Idina Menzel', year: 2013, spotifyId: '1' }],
        },
      ],
    };
    expect(deckSongs('mine', personal)).toHaveLength(1);
    const songs = chooseSongs({ decks: ['movies', 'mine'], mode: 'premium', loggedIn: true, personal });
    expect(songs).toHaveLength(MOVIE_SONGS.length);
    expect(songs[0].id).toBe('sp:1');
  });
});
