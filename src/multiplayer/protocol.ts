import type { GameState, LastGuess, Phase, Player } from '../game/engine';

/**
 * Shared play: the host device (the one that plays the music) opens a room
 * with a short code, and phones join it. Each phone picks a team, and while
 * that team is guessing every member votes for a spot on the timeline. When
 * all of the team's connected members have locked in, the most voted spot is
 * the team's guess.
 *
 * This file is the pure part: the messages, the room state and the vote
 * counting. The connections are in `connection.ts`.
 */

/** Letters and digits that can't be mistaken for each other when read aloud or typed. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;

export function newRoomCode(rng: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  return code;
}

/** Tidies what someone typed: upper case, no spaces or dashes. */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, CODE_LENGTH);
}

export const isValidCode = (code: string) =>
  code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));

export interface Member {
  /** Chosen by the phone and kept across reloads, so a reconnect is the same member. */
  id: string;
  name: string;
  /** The player (team) id from the game, or null until chosen. */
  teamId: string | null;
  connected: boolean;
  /** The slot this member votes for in the current turn. */
  vote: number | null;
  /** Locked in their vote. */
  locked: boolean;
}

export interface Room {
  code: string;
  members: Member[];
}

/** What phones see of the game: everything except the song that is playing. */
export interface GameView {
  players: Player[];
  currentPlayerIndex: number;
  phase: Phase;
  targetCards: number;
  lastGuess: LastGuess | null;
  winnerIds: string[];
  round: number;
}

export interface RoomView {
  code: string;
  members: Member[];
  game: GameView | null;
  /** Set when the team's votes are split and no spot has the most. */
  split: boolean;
}

/** Phone → host. */
export type ClientMessage =
  | { type: 'hello'; memberId: string; name: string }
  | { type: 'team'; teamId: string | null }
  | { type: 'vote'; slot: number | null }
  | { type: 'lock'; locked: boolean };

/** Host → phone. */
export type HostMessage = { type: 'state'; view: RoomView } | { type: 'closed'; reason: string };

export function gameView(game: GameState | null): GameView | null {
  if (!game) return null;
  const { players, currentPlayerIndex, phase, targetCards, lastGuess, winnerIds, round } = game;
  return { players, currentPlayerIndex, phase, targetCards, lastGuess, winnerIds, round };
}

export function roomView(room: Room, game: GameState | null): RoomView {
  const decision = game ? teamDecision(room, game) : null;
  return { code: room.code, members: room.members, game: gameView(game), split: decision?.kind === 'split' };
}

/** The connected members of the team whose turn it is. */
export function activeVoters(room: Room, game: Pick<GameState, 'players' | 'currentPlayerIndex'>): Member[] {
  const teamId = game.players[game.currentPlayerIndex]?.id;
  return room.members.filter((m) => m.connected && m.teamId === teamId);
}

/** Who votes for which slot, as slot → member names. */
export function votesBySlot(members: readonly Member[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const m of members) {
    if (m.vote === null) continue;
    const names = out.get(m.vote);
    if (names) names.push(m.name);
    else out.set(m.vote, [m.name]);
  }
  return out;
}

export type Decision =
  /** Nobody on the team has joined: the host's device decides as usual. */
  | { kind: 'none' }
  /** Some members still have to vote or lock in. */
  | { kind: 'waiting'; locked: number; total: number }
  /** Everyone locked in, but two or more spots have the most votes. */
  | { kind: 'split' }
  /** Everyone locked in: this is the team's guess. */
  | { kind: 'place'; slot: number };

export function teamDecision(room: Room, game: GameState): Decision {
  if (game.phase !== 'guessing') return { kind: 'none' };
  const voters = activeVoters(room, game);
  if (voters.length === 0) return { kind: 'none' };
  const locked = voters.filter((m) => m.locked && m.vote !== null).length;
  if (locked < voters.length) return { kind: 'waiting', locked, total: voters.length };
  const tally = [...votesBySlot(voters)].map(([slot, names]) => ({ slot, n: names.length }));
  const most = Math.max(...tally.map((t) => t.n));
  const top = tally.filter((t) => t.n === most);
  return top.length === 1 ? { kind: 'place', slot: top[0].slot } : { kind: 'split' };
}

/** Everyone's votes cleared, for a new song or turn. */
export function clearVotes(room: Room): Room {
  return { ...room, members: room.members.map((m) => ({ ...m, vote: null, locked: false })) };
}

const cleanName = (name: string) => name.trim().slice(0, 24) || 'Player';

/** Applies a phone's message to the room. Votes only count from the team whose turn it is. */
export function applyMessage(room: Room, game: GameState | null, memberId: string, msg: ClientMessage): Room {
  const members = room.members.slice();
  const i = members.findIndex((m) => m.id === memberId);
  if (msg.type === 'hello') {
    const name = cleanName(msg.name);
    if (i === -1) members.push({ id: memberId, name, teamId: null, connected: true, vote: null, locked: false });
    else members[i] = { ...members[i], name, connected: true };
    return { ...room, members };
  }
  if (i === -1) return room;
  const m = members[i];
  if (msg.type === 'team') {
    const valid = msg.teamId === null || !!game?.players.some((p) => p.id === msg.teamId);
    if (!valid) return room;
    members[i] = { ...m, teamId: msg.teamId, vote: null, locked: false };
  } else {
    const canVote =
      !!game && game.phase === 'guessing' && m.teamId === game.players[game.currentPlayerIndex]?.id;
    if (!canVote) return room;
    if (msg.type === 'vote') {
      const timeline = game.players[game.currentPlayerIndex].timeline;
      const slot = msg.slot === null ? null : Math.trunc(msg.slot);
      if (slot !== null && (slot < 0 || slot > timeline.length)) return room;
      // A changed vote has to be locked in again.
      members[i] = { ...m, vote: slot, locked: false };
    } else {
      members[i] = { ...m, locked: msg.locked && m.vote !== null };
    }
  }
  return { ...room, members };
}

export function setConnected(room: Room, memberId: string, connected: boolean): Room {
  return {
    ...room,
    members: room.members.map((m) =>
      m.id === memberId ? { ...m, connected, ...(connected ? {} : { locked: false }) } : m,
    ),
  };
}

/** The PeerJS id the host registers under. Prefixed so codes don't clash with other apps on the public server. */
export const peerIdFor = (code: string) => `the-musicquiz-${code.toLowerCase()}`;
