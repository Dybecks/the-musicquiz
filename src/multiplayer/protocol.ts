import type { GameState, LastGuess, Phase, Player, Song } from '../game/engine';

/**
 * Shared play: the host device (the one that plays the music) opens a room
 * with a short code, before or during a game, and phones join it. Everyone,
 * the host included, picks a team, and while that team is guessing every
 * member votes for a spot on the timeline. When all of the team's connected
 * members have locked in, the most voted spot is the team's guess. Phones can
 * also send songs from their own Spotify to the game.
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

/** The member id of the host's own device. */
export const HOST_ID = 'host';

/** At most this many songs are taken from one phone at a time. */
export const MAX_SONGS_PER_MESSAGE = 200;

export interface Member {
  /** Chosen by the phone and kept across reloads, so a reconnect is the same member. */
  id: string;
  name: string;
  /** The team (player id in the game, `p1`, `p2`…), or null until chosen. */
  teamId: string | null;
  connected: boolean;
  /** The slot this member votes for in the current turn. */
  vote: number | null;
  /** Locked in their vote. */
  locked: boolean;
  /** How many songs this member added from their Spotify. */
  songs?: number;
  /** A random emoji as a profile picture, given when they join. */
  emoji?: string;
}

/** The emoji people get as their picture. */
export const AVATARS = [
  '🦊', '🐼', '🐸', '🐙', '🦄', '🐝', '🦉', '🐧', '🐯', '🐨', '🦁', '🐵', '🐢', '🦖', '🐳', '🦩',
  '🦔', '🐞', '🦜', '🐬', '🦦', '🐮', '🐷', '🐰', '🌵', '🍄', '🌻', '🍉', '🍩', '🌮', '🎸', '🎺',
  '🥁', '🎷', '🎻', '🎹', '🪩', '🎧', '🚀', '⭐', '🌈', '🔥', '👾', '🤖', '👻', '🎃', '🍕', '🧁',
];

/** A random emoji that nobody else in the room has, if there is one left. */
export function pickAvatar(members: readonly Member[], rng: () => number = Math.random, not?: string): string {
  const taken = new Set(members.map((m) => m.emoji));
  const free = AVATARS.filter((a) => !taken.has(a) && a !== not);
  const pool = free.length ? free : AVATARS.filter((a) => a !== not);
  return pool[Math.floor(rng() * pool.length)];
}

/** A member's name with their picture, as shown on vote tags. */
export const label = (m: Pick<Member, 'name' | 'emoji'>) => (m.emoji ? `${m.emoji} ${m.name}` : m.name);

export interface Room {
  code: string;
  members: Member[];
  /** Songs phones sent before the game started; they join the deck at the start. */
  pending?: Song[];
}

export interface Team {
  id: string;
  name: string;
}

/** Team ids before a game starts match the ids `createGame` gives the players. */
export const lobbyTeams = (names: readonly string[]): Team[] =>
  names.map((n) => n.trim()).filter(Boolean).map((name, i) => ({ id: `p${i + 1}`, name }));

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

/** What is happening on the host's screen right now, beyond the game itself. */
export interface Live {
  /** The song is playing. */
  playing: boolean;
  /** The spot the host has tapped while not voting as a team member. */
  hostPick: number | null;
}

export const NO_LIVE: Live = { playing: false, hostPick: null };

export interface RoomView {
  code: string;
  members: Member[];
  teams: Team[];
  /** Null before the game starts (and between games). */
  game: GameView | null;
  /** Set when the team's votes are split and no spot has the most. */
  split: boolean;
  live: Live;
  /** Songs sent by phones waiting for the game to start. */
  pendingSongs: number;
}

/** Phone → host. */
export type ClientMessage =
  | { type: 'hello'; memberId: string; name: string }
  | { type: 'team'; teamId: string | null }
  | { type: 'vote'; slot: number | null }
  | { type: 'lock'; locked: boolean }
  /** A new random emoji picture. */
  | { type: 'reroll' }
  | { type: 'songs'; songs: Song[] };

/** Host → phone. */
export type HostMessage =
  | { type: 'state'; view: RoomView }
  | { type: 'songs-added'; added: number }
  | { type: 'closed'; reason: string };

export function gameView(game: GameState | null): GameView | null {
  if (!game) return null;
  const { players, currentPlayerIndex, phase, targetCards, lastGuess, winnerIds, round } = game;
  return { players, currentPlayerIndex, phase, targetCards, lastGuess, winnerIds, round };
}

export function teamsOf(game: GameState | null, lobby: readonly Team[]): Team[] {
  return game ? game.players.map(({ id, name }) => ({ id, name })) : lobby.slice();
}

export function roomView(room: Room, game: GameState | null, lobby: readonly Team[] = [], live: Live = NO_LIVE): RoomView {
  const decision = game ? teamDecision(room, game) : null;
  return {
    code: room.code,
    members: room.members,
    teams: teamsOf(game, lobby),
    game: gameView(game),
    split: decision?.kind === 'split',
    live,
    pendingSongs: room.pending?.length ?? 0,
  };
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
    if (names) names.push(label(m));
    else out.set(m.vote, [label(m)]);
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

/** Members whose team no longer exists (a team removed before the start) choose again. */
export function dropMissingTeams(room: Room, teams: readonly Team[]): Room {
  const ids = new Set(teams.map((t) => t.id));
  if (room.members.every((m) => m.teamId === null || ids.has(m.teamId))) return room;
  return { ...room, members: room.members.map((m) => (m.teamId && !ids.has(m.teamId) ? { ...m, teamId: null, vote: null, locked: false } : m)) };
}

const cleanName = (name: string) => name.trim().slice(0, 24) || 'Player';

/** Only well-formed songs from a phone are used. */
export function cleanSongs(input: unknown): Song[] {
  if (!Array.isArray(input)) return [];
  const out: Song[] = [];
  for (const s of input.slice(0, MAX_SONGS_PER_MESSAGE)) {
    if (!s || typeof s !== 'object') continue;
    const { id, title, artist, year, spotifyId } = s as Record<string, unknown>;
    if (typeof title !== 'string' || typeof artist !== 'string' || typeof year !== 'number') continue;
    if (!Number.isInteger(year) || year < 1900 || year > 2100 || !title.trim() || !artist.trim()) continue;
    const sid = typeof spotifyId === 'string' && /^[A-Za-z0-9]{10,40}$/.test(spotifyId) ? spotifyId : undefined;
    out.push({
      id: typeof id === 'string' && id ? id.slice(0, 80) : `phone:${title}|${artist}`.slice(0, 80),
      title: title.slice(0, 200),
      artist: artist.slice(0, 200),
      year,
      ...(sid ? { spotifyId: sid } : {}),
    });
  }
  return out;
}

/**
 * Applies a phone's (or the host's own) message to the room. Votes only
 * count from the team whose turn it is. Songs are handled by the caller.
 */
export function applyMessage(
  room: Room,
  game: GameState | null,
  memberId: string,
  msg: ClientMessage,
  teams: readonly Team[] = teamsOf(game, []),
): Room {
  const members = room.members.slice();
  const i = members.findIndex((m) => m.id === memberId);
  if (msg.type === 'hello') {
    const name = cleanName(msg.name);
    if (i === -1) {
      members.push({ id: memberId, name, teamId: null, connected: true, vote: null, locked: false, emoji: pickAvatar(members) });
    } else {
      members[i] = { ...members[i], name, connected: true, emoji: members[i].emoji ?? pickAvatar(members) };
    }
    return { ...room, members };
  }
  if (i === -1 || msg.type === 'songs') return room;
  const m = members[i];
  if (msg.type === 'reroll') {
    members[i] = { ...m, emoji: pickAvatar(members, Math.random, m.emoji) };
  } else if (msg.type === 'team') {
    const valid = msg.teamId === null || teams.some((t) => t.id === msg.teamId);
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

export function countSongs(room: Room, memberId: string, added: number): Room {
  return { ...room, members: room.members.map((m) => (m.id === memberId ? { ...m, songs: (m.songs ?? 0) + added } : m)) };
}

/** The PeerJS id the host registers under. Prefixed so codes don't clash with other apps on the public server. */
export const peerIdFor = (code: string) => `the-musicquiz-${code.toLowerCase()}`;
