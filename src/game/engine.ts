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
  /** Coins to spend on power-ups (game mode 'powerups'). */
  coins?: number;
  /** Frozen by another team: misses their next turn (game mode 'powerups'). */
  frozen?: boolean;
  /** Out of the game after a wrong placement (game mode 'sudden'). */
  out?: boolean;
}

/**
 * How the game is played:
 *  - 'classic': place the song on your timeline, first to the target number of cards wins;
 *  - 'bonus': the same, plus a multiple-choice question about each song while it plays.
 *    A right answer gives a star, and cards plus stars count toward the target.
 *  - 'steal': a song placed wrong goes to the next team, who can take it by placing it
 *    right on their own timeline; then they play their own turn.
 *  - 'powerups': a right placement earns a coin, and coins buy power-ups (see POWERS).
 *  - 'sudden': one wrong placement and the team is out; the last team left wins.
 */
export type GameMode = 'classic' | 'bonus' | 'steal' | 'powerups' | 'sudden';
export const GAME_MODES: GameMode[] = ['classic', 'bonus', 'steal', 'powerups', 'sudden'];

/**
 * What coins buy in mode 'powerups', on your own turn before locking in:
 *  - 'hint': shows the song's decade;
 *  - 'retry': a second try if this placement is wrong;
 *  - 'freeze': another team misses its next turn;
 *  - 'grab': take a random card from another team's timeline (they keep at least one).
 */
export type Power = 'hint' | 'retry' | 'freeze' | 'grab';
export const POWERS: Power[] = ['hint', 'retry', 'freeze', 'grab'];
export const POWER_COST: Record<Power, number> = { hint: 1, retry: 2, freeze: 2, grab: 3 };
/** Powers aimed at another team. */
export const isAttack = (power: Power) => power === 'freeze' || power === 'grab';
/** Coins every team starts with in mode 'powerups'. */
export const START_COINS = 1;

/** Power-ups used in the current turn. */
export interface TurnPowers {
  /** The decade of the song is shown. */
  hint?: boolean;
  /** A wrong placement gets one more try. */
  retry?: boolean;
  /** The second try is under way: the first went into this slot. */
  missedSlot?: number;
  /** An attack was used (one per turn). */
  attacked?: boolean;
}

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
  /** This was a steal of a song another team missed (mode 'steal'). */
  steal?: boolean;
  /** Placed wrong: the next team gets to steal it (mode 'steal'). */
  stealNext?: string;
  /** The team is out of the game (mode 'sudden'). */
  eliminated?: boolean;
  /** A coin was earned (mode 'powerups'). */
  coin?: boolean;
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
  /** The current player is trying to steal the song the previous team missed (mode 'steal'). */
  stealing?: boolean;
  /** Power-ups used this turn (mode 'powerups'). */
  powers?: TurnPowers;
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
  const players: Player[] = names.map((name, i) => ({
    id: `p${i + 1}`,
    name,
    timeline: [],
    ...(mode === 'powerups' ? { coins: START_COINS } : {}),
  }));
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
  const mode = modeOf(state);
  // A wrong placement with a second try bought: try again, nothing revealed yet.
  if (!correct && mode === 'powerups' && state.powers?.retry && state.powers.missedSlot === undefined) {
    return { ...state, powers: { ...state.powers, missedSlot: slot } };
  }
  const coin = mode === 'powerups' && correct;
  const eliminated = mode === 'sudden' && !correct;
  const players = state.players.map((p) => {
    if (p.id !== player.id) return p;
    let next = correct ? { ...p, timeline: insertSorted(p.timeline, song) } : p;
    if (bonus?.correct) next = { ...next, stars: (p.stars ?? 0) + 1 };
    if (coin) next = { ...next, coins: (p.coins ?? 0) + 1 };
    if (eliminated) next = { ...next, out: true };
    return next;
  });
  const stealer = mode === 'steal' && !correct && !state.stealing ? players[nextIndex(state, players).index] : null;
  return {
    ...state,
    players,
    phase: 'revealed',
    lastGuess: {
      playerId: player.id,
      song,
      slot,
      correct,
      ...(bonus ? { bonus } : {}),
      ...(state.stealing ? { steal: true } : {}),
      ...(stealer && stealer.id !== player.id ? { stealNext: stealer.id } : {}),
      ...(eliminated ? { eliminated: true } : {}),
      ...(coin ? { coin: true } : {}),
    },
    winnerIds: winnersOf(state, players),
  };
}

/** Who has won after a placement: the target reached, or (mode 'sudden') the last team left. */
function winnersOf(state: GameState, players: Player[]): string[] {
  const reached = players.filter((p) => !p.out && scoreOf(p) >= state.targetCards).map((p) => p.id);
  if (reached.length || modeOf(state) !== 'sudden') return reached;
  const left = players.filter((p) => !p.out);
  if (players.length > 1 && left.length === 1) return [left[0].id];
  // Playing alone: the game ends with the first miss.
  if (left.length === 0) return players.map((p) => p.id);
  return [];
}

/**
 * Whose turn is after the current player's: teams that are out are passed
 * over, and a frozen team misses one turn (and thaws). Counts the rounds.
 */
function nextIndex(state: Pick<GameState, 'currentPlayerIndex' | 'round'>, players: Player[]): { index: number; round: number; players: Player[] } {
  let index = state.currentPlayerIndex;
  let round = state.round;
  let out = players;
  for (let i = 0; i < players.length * 2; i++) {
    index = (index + 1) % players.length;
    if (index === 0) round += 1;
    const p = out[index];
    if (p.out) continue;
    if (p.frozen) {
      out = out.map((x, j) => (j === index ? { ...x, frozen: false } : x));
      continue;
    }
    return { index, round, players: out };
  }
  // Nobody else can play: the current player goes again.
  return { index: state.currentPlayerIndex, round, players: out };
}

/** Move on after a reveal: either the game is won, or the next player draws. */
export function nextTurn(state: GameState): GameState {
  if (state.phase !== 'revealed') return state;
  if (state.winnerIds.length > 0) return { ...state, phase: 'finished', current: null, question: null };
  const steal = state.lastGuess?.stealNext;
  if (steal) {
    // The same song, for the next team to steal.
    const index = state.players.findIndex((p) => p.id === steal);
    return {
      ...state,
      currentPlayerIndex: index,
      round: index <= state.currentPlayerIndex ? state.round + 1 : state.round,
      phase: 'guessing',
      lastGuess: null,
      stealing: true,
      powers: undefined,
    };
  }
  // After a steal the stealing team plays its own turn.
  return drawFor(state, !state.stealing);
}

/** The next song, for the next player (or with `advance` false, the same one again). */
function drawFor(state: GameState, advance: boolean): GameState {
  const deck = state.deck.slice();
  const current = deck.shift() ?? null;
  if (!current) return finishByMostCards(state);
  const next = advance ? nextIndex(state, state.players) : { index: state.currentPlayerIndex, round: state.round, players: state.players };
  return withQuestion({
    ...state,
    deck,
    current,
    used: [...(state.used ?? []), songKeyOf(current)],
    players: next.players,
    currentPlayerIndex: next.index,
    round: next.round,
    phase: 'guessing',
    lastGuess: null,
    stealing: false,
    powers: undefined,
  });
}

/**
 * Uses a power-up on the current player's turn (mode 'powerups'), paying its
 * cost in coins. `targetId` is the team an attack is aimed at. Does nothing
 * when it can't be used: too few coins, already used this turn, a bad target.
 */
export function applyPower(state: GameState, power: Power, targetId?: string, rng: Rng = Math.random): GameState {
  if (modeOf(state) !== 'powerups' || state.phase !== 'guessing' || !POWERS.includes(power)) return state;
  const me = currentPlayer(state);
  const cost = POWER_COST[power];
  const turn = state.powers ?? {};
  if ((me.coins ?? 0) < cost) return state;
  if (power === 'hint' && turn.hint) return state;
  if (power === 'retry' && turn.retry) return state;
  if (isAttack(power) && turn.attacked) return state;
  const target = isAttack(power) ? state.players.find((p) => p.id === targetId && p.id !== me.id && !p.out) : undefined;
  if (isAttack(power) && !target) return state;
  if (power === 'freeze' && target!.frozen) return state;
  if (power === 'grab' && target!.timeline.length < 2) return state;

  let players = state.players.map((p) => (p.id === me.id ? { ...p, coins: (p.coins ?? 0) - cost } : p));
  if (power === 'freeze') players = players.map((p) => (p.id === target!.id ? { ...p, frozen: true } : p));
  if (power === 'grab') {
    const card = target!.timeline[Math.min(target!.timeline.length - 1, Math.floor(rng() * target!.timeline.length))];
    players = players.map((p) =>
      p.id === target!.id
        ? { ...p, timeline: p.timeline.filter((s) => s !== card) }
        : p.id === me.id
          ? { ...p, timeline: insertSorted(p.timeline, card) }
          : p,
    );
  }
  const powers: TurnPowers = {
    ...turn,
    ...(power === 'hint' ? { hint: true } : {}),
    ...(power === 'retry' ? { retry: true } : {}),
    ...(isAttack(power) ? { attacked: true } : {}),
  };
  return { ...state, players, powers };
}

/** Whether the current player could use a power-up now (ignoring the target). */
export function canUsePower(state: GameState, power: Power): boolean {
  if (modeOf(state) !== 'powerups' || state.phase !== 'guessing') return false;
  const turn = state.powers ?? {};
  if ((currentPlayer(state).coins ?? 0) < POWER_COST[power]) return false;
  if (power === 'hint') return !turn.hint;
  if (power === 'retry') return !turn.retry;
  return !turn.attacked && attackTargets(state, power).length > 0;
}

/** The teams an attack can be aimed at. */
export function attackTargets(state: Pick<GameState, 'players' | 'currentPlayerIndex'>, power: Power): Player[] {
  const me = state.players[state.currentPlayerIndex];
  return state.players.filter(
    (p) => p.id !== me.id && !p.out && (power === 'freeze' ? !p.frozen : power === 'grab' ? p.timeline.length >= 2 : false),
  );
}

/** The decade of a year, for the hint: 1987 → 1980. */
export const decadeOf = (year: number) => Math.floor(year / 10) * 10;

/** Swap the current song for a new one without using up the turn (e.g. track not found on Spotify). */
export function skipSong(state: GameState): GameState {
  if (state.phase !== 'guessing') return state;
  const deck = state.deck.slice();
  const current = deck.shift() ?? null;
  if (!current) return finishByMostCards(state);
  // Skipping a song that was up for stealing ends the steal: the team plays its own turn.
  return withQuestion({ ...state, deck, current, used: [...(state.used ?? []), songKeyOf(current)], stealing: false, powers: state.stealing ? undefined : state.powers });
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
  const left = state.players.filter((p) => !p.out);
  const most = Math.max(...(left.length ? left : state.players).map(scoreOf));
  return {
    ...state,
    deck: [],
    current: null,
    question: null,
    phase: 'finished',
    winnerIds: (left.length ? left : state.players).filter((p) => scoreOf(p) === most).map((p) => p.id),
  };
}

/** Who plays after this reveal: the team that may steal the song, or else the next team whose turn it is. */
export function upNext(state: Pick<GameState, 'players' | 'currentPlayerIndex' | 'round' | 'lastGuess' | 'stealing'>): Player {
  const steal = state.lastGuess?.stealNext;
  if (steal) return state.players.find((p) => p.id === steal) ?? state.players[0];
  if (state.stealing) return state.players[state.currentPlayerIndex];
  return state.players[nextIndex(state, state.players).index];
}
