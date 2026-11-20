import { describe, expect, it } from 'vitest';
import { addSongs, createGame, insertSorted, isCorrectPlacement, nextTurn, placeCurrent, skipSong, spreadByDecade, type Song } from './engine';

const song = (year: number, id = `s${year}`): Song => ({ id, title: `Song ${year}`, artist: 'Artist', year });
const songs = [1960, 1970, 1980, 1990, 2000, 2010, 2020].map((y) => song(y));
// Deterministic "rng" that never shuffles (always picks the last index).
const noShuffle = () => 0.999999;

describe('isCorrectPlacement', () => {
  const timeline = [song(1970), song(1990)];
  it('accepts a year before the first card', () => expect(isCorrectPlacement(timeline, 0, 1965)).toBe(true));
  it('accepts a year between cards', () => expect(isCorrectPlacement(timeline, 1, 1980)).toBe(true));
  it('accepts a year after the last card', () => expect(isCorrectPlacement(timeline, 2, 2005)).toBe(true));
  it('rejects a wrong slot', () => {
    expect(isCorrectPlacement(timeline, 0, 1980)).toBe(false);
    expect(isCorrectPlacement(timeline, 2, 1980)).toBe(false);
  });
  it('treats equal years as correct on both sides', () => {
    expect(isCorrectPlacement(timeline, 0, 1970)).toBe(true);
    expect(isCorrectPlacement(timeline, 1, 1970)).toBe(true);
  });
  it('rejects out-of-range slots', () => expect(isCorrectPlacement(timeline, 5, 1980)).toBe(false));
});

describe('insertSorted', () => {
  it('keeps the timeline ordered by year', () => {
    expect(insertSorted([song(1970), song(1990)], song(1980)).map((s) => s.year)).toEqual([1970, 1980, 1990]);
  });
});

describe('game flow', () => {
  it('deals one starting card per player and draws a song', () => {
    const g = createGame({ playerNames: ['A', 'B'], targetCards: 3, songs, rng: noShuffle });
    expect(g.players.map((p) => p.timeline.length)).toEqual([1, 1]);
    expect(g.current).not.toBeNull();
    expect(g.deck.length).toBe(songs.length - 3);
  });

  it('adds the card on a correct guess and moves to the next player', () => {
    let g = createGame({ playerNames: ['A', 'B'], targetCards: 3, songs, rng: noShuffle });
    const start = g.players[0].timeline[0].year;
    const slot = g.current!.year < start ? 0 : 1;
    g = placeCurrent(g, slot);
    expect(g.lastGuess?.correct).toBe(true);
    expect(g.players[0].timeline).toHaveLength(2);
    g = nextTurn(g);
    expect(g.currentPlayerIndex).toBe(1);
    expect(g.phase).toBe('guessing');
  });

  it('discards the card on a wrong guess', () => {
    let g = createGame({ playerNames: ['A'], targetCards: 3, songs, rng: noShuffle });
    const start = g.players[0].timeline[0].year;
    const wrongSlot = g.current!.year < start ? 1 : 0;
    g = placeCurrent(g, wrongSlot);
    expect(g.lastGuess?.correct).toBe(false);
    expect(g.players[0].timeline).toHaveLength(1);
  });

  it('ends the game when a player reaches the target', () => {
    let g = createGame({ playerNames: ['A'], targetCards: 2, songs, rng: noShuffle });
    const start = g.players[0].timeline[0].year;
    g = placeCurrent(g, g.current!.year < start ? 0 : 1);
    expect(g.winnerIds).toEqual(['p1']);
    g = nextTurn(g);
    expect(g.phase).toBe('finished');
  });

  it('ends with the most cards when the deck runs out', () => {
    let g = createGame({ playerNames: ['A', 'B'], targetCards: 99, songs: songs.slice(0, 3), rng: noShuffle });
    g = nextTurn(placeCurrent(g, 99)); // invalid slot = wrong guess, deck now empty
    expect(g.phase).toBe('finished');
    expect(g.winnerIds).toEqual(['p1', 'p2']);
  });

  it('skipSong swaps the current song without changing the player', () => {
    const g = createGame({ playerNames: ['A', 'B'], targetCards: 3, songs, rng: noShuffle });
    const skipped = skipSong(g);
    expect(skipped.current?.id).not.toBe(g.current?.id);
    expect(skipped.currentPlayerIndex).toBe(0);
  });
});

describe('default deck', () => {
  it('has enough songs with Spotify ids to play without logging in', async () => {
    const { DEFAULT_SONGS, NO_LOGIN_SONGS } = await import('../data/songs');
    expect(NO_LOGIN_SONGS.length).toBeGreaterThanOrEqual(50);
    expect(NO_LOGIN_SONGS.every((s) => /^[0-9A-Za-z]{22}$/.test(s.spotifyId ?? ''))).toBe(true);
    expect(new Set(DEFAULT_SONGS.map((s) => s.id)).size).toBe(DEFAULT_SONGS.length);
  });
});

describe('spreadByDecade', () => {
  it('draws each decade about equally often, however many songs it has', () => {
    // 90 songs from the 2010s, 10 from the 1970s.
    const many = [...Array.from({ length: 90 }, (_, i) => song(2010 + (i % 10), `n${i}`)), ...Array.from({ length: 10 }, (_, i) => song(1970 + i, `o${i}`))];
    let seventies = 0;
    for (let run = 0; run < 50; run++) seventies += spreadByDecade(many).slice(0, 10).filter((s) => s.year < 1980).length;
    // A plain shuffle would give about 1 in 10; spreading gives about 5 in 10.
    expect(seventies / 50).toBeGreaterThan(3);
  });

  it('keeps every song exactly once', () => {
    const out = spreadByDecade(songs);
    expect(out.map((s) => s.id).sort()).toEqual(songs.map((s) => s.id).sort());
  });
});

describe('addSongs', () => {
  it('appends new songs and leaves out ones already dealt or in the deck', () => {
    const g = createGame({ playerNames: ['A'], targetCards: 3, songs: songs.slice(0, 3), rng: noShuffle });
    const dealt = g.players[0].timeline[0];
    const next = addSongs(g, [dealt, g.deck[0], song(1955), song(1955, 'other-release')], { more: true }, noShuffle);
    expect(next.deck.map((s) => s.year).sort()).toEqual([...g.deck.map((s) => s.year), 1955].sort());
    expect(next.refill).toEqual({ more: true });
  });
  it('mixes a batch from one decade in with the rest instead of queueing it at the end', () => {
    const g = { ...createGame({ playerNames: ['A'], targetCards: 5, songs: [1990, 1991, 1992, 1993, 1994, 1995].map((y) => song(y)) }), deck: [] };
    const nineties = [1996, 1997, 1998, 1999].map((y) => song(y));
    const eighties = [1981, 1982, 1983, 1984].map((y) => song(y));
    let mixedFirstHalf = 0;
    for (let i = 0; i < 50; i++) {
      const deck = addSongs(addSongs(g, nineties, undefined), eighties, undefined).deck;
      if (deck.slice(0, 4).some((s) => s.year < 1990)) mixedFirstHalf++;
    }
    expect(mixedFirstHalf).toBeGreaterThan(40);
  });
  it('remembers drawn songs so they are not added again', () => {
    let g = createGame({ playerNames: ['A'], targetCards: 5, songs, rng: noShuffle });
    const first = g.current!;
    g = skipSong(g);
    expect(addSongs(g, [first], undefined).deck).toHaveLength(g.deck.length);
  });
});
