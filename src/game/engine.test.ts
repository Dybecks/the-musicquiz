import { describe, expect, it } from 'vitest';
import { createGame, insertSorted, isCorrectPlacement, nextTurn, placeCurrent, skipSong, type Song } from './engine';

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
