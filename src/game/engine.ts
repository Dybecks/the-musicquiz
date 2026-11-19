import type { Genre } from '../data/genres';

/**
 * Pure game logic for the music timeline game. No React, no Spotify:
 * every function takes a state and returns a new one, so it is easy to test
 * and to persist in localStorage.
 */

export interface Song {
  id: string;
  title: string;
  artist: string;
  year: number;
  /** Optional Spotify track id; when missing the track is found via search. */
  spotifyId?: string;
  /** Genres, used to narrow down the deck. Unknown when missing. */
  genres?: Genre[];
}

export interface Player {
  id: string;
  name: string;
  /** Always sorted by year, oldest first. */
  timeline: Song[];
}

export type Phase = 'guessing' | 'revealed' | 'finished';

export interface LastGuess {
  playerId: string;
  song: Song;
  slot: number;
  correct: boolean;
}

export interface GameState {
  players: Player[];
  currentPlayerIndex: number;
  deck: Song[];
  current: Song | null;
  phase: Phase;
  targetCards: number;
  lastGuess: LastGuess | null;
  winnerIds: string[];
  round: number;
}

export type Rng = () => number;

export function shuffle<T>(items: readonly T[], rng: Rng = Math.random): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface NewGameOptions {
  playerNames: string[];
  targetCards: number;
  songs: readonly Song[];
  rng?: Rng;
}

export function createGame({ playerNames, targetCards, songs, rng = Math.random }: NewGameOptions): GameState {
  const names = playerNames.map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) throw new Error('Add at least one player or team.');
  if (targetCards < 2) throw new Error('The target must be at least 2 cards.');
  if (songs.length < names.length + 1) throw new Error('Not enough songs in the deck.');

  const deck = shuffle(songs, rng);
  // Each player gets one face-up starting card. Try to give everyone a
  // different decade-ish start so the timelines don't all look the same.
  const players: Player[] = names.map((name, i) => ({ id: `p${i + 1}`, name, timeline: [] }));
  for (const player of players) {
    const usedYears = new Set(players.flatMap((p) => p.timeline.map((s) => s.year)));
    let idx = deck.findIndex((s) => !usedYears.has(s.year));
    if (idx === -1) idx = 0;
    const [start] = deck.splice(idx, 1);
    player.timeline = [start];
  }

  const current = deck.shift() ?? null;
  return {
    players,
    currentPlayerIndex: 0,
    deck,
    current,
    phase: 'guessing',
    targetCards,
    lastGuess: null,
    winnerIds: [],
    round: 1,
  };
}

/**
 * A slot is an index into the gaps of the timeline: slot 0 is before the first
 * card, slot `timeline.length` is after the last. A placement is correct when
 * the song's year fits between its neighbours; equal years count as correct
 * on either side.
 */
export function isCorrectPlacement(timeline: readonly Song[], slot: number, year: number): boolean {
  if (slot < 0 || slot > timeline.length) return false;
  const before = timeline[slot - 1];
  const after = timeline[slot];
  if (before && year < before.year) return false;
  if (after && year > after.year) return false;
  return true;
}

export function insertSorted(timeline: readonly Song[], song: Song): Song[] {
  const out = timeline.slice();
  let i = out.findIndex((s) => s.year > song.year);
  if (i === -1) i = out.length;
  out.splice(i, 0, song);
  return out;
}

export function currentPlayer(state: GameState): Player {
  return state.players[state.currentPlayerIndex];
}

export function placeCurrent(state: GameState, slot: number): GameState {
  if (state.phase !== 'guessing' || !state.current) return state;
  const player = currentPlayer(state);
  const song = state.current;
  const correct = isCorrectPlacement(player.timeline, slot, song.year);
  const players = state.players.map((p) =>
    p.id === player.id && correct ? { ...p, timeline: insertSorted(p.timeline, song) } : p,
  );
  const winnerIds = players.filter((p) => p.timeline.length >= state.targetCards).map((p) => p.id);
  return {
    ...state,
    players,
    phase: 'revealed',
    lastGuess: { playerId: player.id, song, slot, correct },
    winnerIds,
  };
}

/** Move on after a reveal: either the game is won, or the next player draws. */
export function nextTurn(state: GameState): GameState {
  if (state.phase !== 'revealed') return state;
  if (state.winnerIds.length > 0) return { ...state, phase: 'finished', current: null };
  return drawForNextPlayer(state);
}

function drawForNextPlayer(state: GameState): GameState {
  const deck = state.deck.slice();
  const current = deck.shift() ?? null;
  if (!current) return finishByMostCards(state);
  const nextIndex = (state.currentPlayerIndex + 1) % state.players.length;
  return {
    ...state,
    deck,
    current,
    currentPlayerIndex: nextIndex,
    round: nextIndex === 0 ? state.round + 1 : state.round,
    phase: 'guessing',
    lastGuess: null,
  };
}

/** Swap the current song for a new one without using up the turn (e.g. track not found on Spotify). */
export function skipSong(state: GameState): GameState {
  if (state.phase !== 'guessing') return state;
  const deck = state.deck.slice();
  const current = deck.shift() ?? null;
  if (!current) return finishByMostCards(state);
  return { ...state, deck, current };
}

function finishByMostCards(state: GameState): GameState {
  const most = Math.max(...state.players.map((p) => p.timeline.length));
  return {
    ...state,
    deck: [],
    current: null,
    phase: 'finished',
    winnerIds: state.players.filter((p) => p.timeline.length === most).map((p) => p.id),
  };
}
