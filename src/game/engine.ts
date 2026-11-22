import type { Genre } from '../data/genres';
import { msg } from '../i18n';

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
  /** The film, show, game or musical the song is from, shown on the card. */
  from?: string;
}

export interface Player {
  id: string;
  name: string;
  /** Always sorted by year, oldest first. */
  timeline: Song[];
  /** Bonus points from bonus questions (game mode 'bonus'). Count toward the target like cards. */
  stars?: number;
}

/**
 * How the game is played:
 *  - 'classic': place the song on your timeline, first to the target number of cards wins;
 *  - 'bonus': the same, plus a multiple-choice question about each song while it plays.
 *    A right answer gives a star, and cards plus stars count toward the target.
 */
export type GameMode = 'classic' | 'bonus';
export const GAME_MODES: GameMode[] = ['classic', 'bonus'];

/** What a bonus question asks: who performs the song, its title, or the film/show/game/musical it is from. */
export type QuestionKind = 'artist' | 'title' | 'from';

export interface BonusQuestion {
  kind: QuestionKind;
  /** Four (or at least two) different answers to choose from. */
  choices: string[];
  /** Index of the right one in `choices`. Never sent to phones before the reveal. */
  answer: number;
}

/** How the team answered the bonus question, kept with the reveal. */
export interface BonusResult {
  question: BonusQuestion;
  /** The chosen answer, or null when the team didn't choose one. */
  pick: number | null;
  correct: boolean;
}

export type Phase = 'guessing' | 'revealed' | 'finished';

export interface LastGuess {
  playerId: string;
  song: Song;
  slot: number;
  correct: boolean;
  /** The bonus question for this song and how it was answered (mode 'bonus'). */
  bonus?: BonusResult;
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
  /**
   * Where more songs come from when the deck runs low (a list fetched a few
   * songs at a time). Opaque to the engine; missing means the deck is all there is.
   */
  refill?: unknown;
  /** Songs already dealt (as `songKey`s), so songs fetched later don't repeat them. */
  used?: string[];
  /** Missing in games saved before there were modes: 'classic'. */
  mode?: GameMode;
  /** The bonus question about `current`, in mode 'bonus' (null when no good one could be made). */
  question?: BonusQuestion | null;
}

export const modeOf = (state: Pick<GameState, 'mode'>): GameMode =>
  state.mode && GAME_MODES.includes(state.mode) ? state.mode : 'classic';

/** A player's score: cards on the timeline plus bonus stars. */
export const scoreOf = (p: Pick<Player, 'timeline' | 'stars'>) => p.timeline.length + (p.stars ?? 0);

/** Identifies a song across releases: same title and artist. */
export const songKeyOf = (s: Pick<Song, 'title' | 'artist'>) => `${s.title}|${s.artist}`.toLowerCase();

export type Rng = () => number;

export function shuffle<T>(items: readonly T[], rng: Rng = Math.random): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Orders songs so that every decade comes up about equally often, however
 * many songs each decade has: each draw picks a random decade among those
 * left, then a random song from it. Big decades are used up last.
 */
export function spreadByDecade(songs: readonly Song[], rng: Rng = Math.random): Song[] {
  const groups = new Map<number, Song[]>();
  for (const song of shuffle(songs, rng)) {
    const decade = Math.floor(song.year / 10) * 10;
    const group = groups.get(decade);
    if (group) group.push(song);
    else groups.set(decade, [song]);
  }
  const lists = [...groups.values()];
  const out: Song[] = [];
  while (lists.length) {
    const i = Math.min(lists.length - 1, Math.floor(rng() * lists.length));
    out.push(lists[i].pop()!);
    if (lists[i].length === 0) lists.splice(i, 1);
  }
  return out;
}

/** How many wrong answers a bonus question has, at most and at least. */
const DECOYS = 3;
const MIN_DECOYS = 2;

const valueOf = (song: Song, kind: QuestionKind): string | undefined =>
  kind === 'artist' ? song.artist : kind === 'title' ? song.title : song.from;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Wrong answers for `song`: values from other songs, preferring songs from
 * years close to it, so the choices sound plausible together.
 */
function decoysFor(song: Song, kind: QuestionKind, pool: readonly Song[], rng: Rng): string[] {
  const right = valueOf(song, kind);
  if (!right) return [];
  const candidates = shuffle(pool, rng)
    .filter((s) => s.id !== song.id && (kind !== 'artist' || !same(s.artist, song.artist)))
    .map((s) => ({ value: valueOf(s, kind), gap: Math.abs(s.year - song.year) + rng() * 8 }))
    .filter((c): c is { value: string; gap: number } => !!c.value && !same(c.value, right))
    .sort((a, b) => a.gap - b.gap);
  const out: string[] = [];
  for (const c of candidates) {
    if (out.some((v) => same(v, c.value))) continue;
    out.push(c.value);
    if (out.length === DECOYS) break;
  }
  return out;
}

/**
 * A multiple-choice question about `song`, with wrong answers taken from the
 * other songs in `pool`: where a soundtrack song is from when it has that,
 * otherwise who performs it or what it is called. Null when the pool hasn't
 * enough different answers.
 */
export function makeQuestion(song: Song, pool: readonly Song[], rng: Rng = Math.random): BonusQuestion | null {
  const kinds: QuestionKind[] = rng() < 0.5 ? ['artist', 'title'] : ['title', 'artist'];
  if (song.from) kinds.unshift('from');
  for (const kind of kinds) {
    const right = valueOf(song, kind);
    const decoys = decoysFor(song, kind, pool, rng);
    if (!right || decoys.length < MIN_DECOYS) continue;
    const choices = shuffle([right, ...decoys], rng);
    return { kind, choices, answer: choices.indexOf(right) };
  }
  return null;
}

/** Every song the game knows of right now, for the wrong answers of a bonus question. */
const knownSongs = (state: Pick<GameState, 'deck' | 'players' | 'current'>): Song[] => [
  ...state.deck,
  ...state.players.flatMap((p) => p.timeline),
  ...(state.current ? [state.current] : []),
];

/** The state with a fresh bonus question for its current song, in mode 'bonus'. */
function withQuestion<S extends GameState>(state: S, rng: Rng = Math.random): S {
  if (modeOf(state) !== 'bonus') return state;
  return { ...state, question: state.current ? makeQuestion(state.current, knownSongs(state), rng) : null };
}

export interface NewGameOptions {
  playerNames: string[];
  /** Missing: 'classic'. */
  mode?: GameMode;
  targetCards: number;
  songs: readonly Song[];
  /** 'decades' spreads the songs evenly over the decades; 'random' (default) is a plain shuffle. */
  order?: 'random' | 'decades';
  rng?: Rng;
}

export function createGame({ playerNames, targetCards, songs, mode = 'classic', order = 'random', rng = Math.random }: NewGameOptions): GameState {
  const names = playerNames.map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) throw new Error(msg().setup.addPlayer);
  if (targetCards < 2) throw new Error(msg().errors.targetTooLow);
  if (songs.length < names.length + 1) throw new Error(msg().errors.notEnoughSongs);

  const deck = order === 'decades' ? spreadByDecade(songs, rng) : shuffle(songs, rng);
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
  return withQuestion({
    mode,
    players,
    currentPlayerIndex: 0,
    deck,
    current,
    phase: 'guessing',
    targetCards,
    lastGuess: null,
    winnerIds: [],
    round: 1,
    used: [...players.map((p) => songKeyOf(p.timeline[0])), ...(current ? [songKeyOf(current)] : [])],
  }, rng);
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

/**
 * Locks in the guess: `slot` on the timeline, and in mode 'bonus' `pick`,
 * the index of the chosen answer to the bonus question (null for none).
 */
export function placeCurrent(state: GameState, slot: number, pick: number | null = null): GameState {
  if (state.phase !== 'guessing' || !state.current) return state;
  const player = currentPlayer(state);
  const song = state.current;
  const correct = isCorrectPlacement(player.timeline, slot, song.year);
  const question = modeOf(state) === 'bonus' ? state.question : null;
  const bonus: BonusResult | undefined = question
    ? { question, pick: pick !== null && pick >= 0 && pick < question.choices.length ? pick : null, correct: pick === question.answer }
    : undefined;
  const players = state.players.map((p) => {
    if (p.id !== player.id) return p;
    const next = correct ? { ...p, timeline: insertSorted(p.timeline, song) } : p;
    return bonus?.correct ? { ...next, stars: (p.stars ?? 0) + 1 } : next;
  });
  const winnerIds = players.filter((p) => scoreOf(p) >= state.targetCards).map((p) => p.id);
  return {
    ...state,
    players,
    phase: 'revealed',
    lastGuess: { playerId: player.id, song, slot, correct, ...(bonus ? { bonus } : {}) },
    winnerIds,
  };
}

/** Move on after a reveal: either the game is won, or the next player draws. */
export function nextTurn(state: GameState): GameState {
  if (state.phase !== 'revealed') return state;
  if (state.winnerIds.length > 0) return { ...state, phase: 'finished', current: null, question: null };
  return drawForNextPlayer(state);
}

function drawForNextPlayer(state: GameState): GameState {
  const deck = state.deck.slice();
  const current = deck.shift() ?? null;
  if (!current) return finishByMostCards(state);
  const nextIndex = (state.currentPlayerIndex + 1) % state.players.length;
  return withQuestion({
    ...state,
    deck,
    current,
    used: [...(state.used ?? []), songKeyOf(current)],
    currentPlayerIndex: nextIndex,
    round: nextIndex === 0 ? state.round + 1 : state.round,
    phase: 'guessing',
    lastGuess: null,
  });
}

/** Swap the current song for a new one without using up the turn (e.g. track not found on Spotify). */
export function skipSong(state: GameState): GameState {
  if (state.phase !== 'guessing') return state;
  const deck = state.deck.slice();
  const current = deck.shift() ?? null;
  if (!current) return finishByMostCards(state);
  return withQuestion({ ...state, deck, current, used: [...(state.used ?? []), songKeyOf(current)] });
}

/**
 * Adds freshly fetched songs to the deck, spread over the decades,
 * leaving out songs already dealt or waiting in the deck. `refill` replaces
 * the state's refill (undefined when the source has nothing more).
 */
export function addSongs(state: GameState, songs: readonly Song[], refill: unknown, rng: Rng = Math.random): GameState {
  const seen = new Set([...(state.used ?? []), ...state.deck.map(songKeyOf), ...state.players.flatMap((p) => p.timeline.map(songKeyOf))]);
  const fresh: Song[] = [];
  for (const s of songs) {
    const key = songKeyOf(s);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(s);
  }
  // The whole remaining deck is dealt again spread over the decades, so a
  // batch from one decade doesn't come up all in a row.
  const next = { ...state, deck: spreadByDecade([...state.deck, ...fresh], rng), refill };
  // Too few songs for a bonus question before: maybe there are enough now.
  return next.phase === 'guessing' && next.question === null ? withQuestion(next, rng) : next;
}

function finishByMostCards(state: GameState): GameState {
  const most = Math.max(...state.players.map(scoreOf));
  return {
    ...state,
    deck: [],
    current: null,
    question: null,
    phase: 'finished',
    winnerIds: state.players.filter((p) => scoreOf(p) === most).map((p) => p.id),
  };
}
