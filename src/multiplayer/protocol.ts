import { POWERS, decadeOf, modeOf, type GameMode, type Power, type GameState, type LastGuess, type Phase, type Player, type QuestionKind, type Song } from '../game/engine';

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
  /** The answer (index into the choices) this member votes for on the bonus question. */
  answer?: number | null;
  /** How many songs this member added from their Spotify. */
  songs?: number;
  /** A random emoji as a profile picture, given when they join. */
  emoji?: string;
  /** The turn (`turnOf`) after whose reveal this member wants the next song. */
  next?: string;
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
  /** Members the host removed: they can't join this room again unless let back in. */
  kicked?: { id: string; name: string }[];
  /** Who moves the game on after a reveal (and plays or pauses) besides the host. Missing: 'majority'. */
  nextRule?: NextRule;
}

/**
 * Besides the host, who starts the next song after the reveal:
 *  - 'host': only the host (phones can't play or pause either),
 *  - 'anyone': any player's tap,
 *  - 'majority': more than half of the connected players tap "Next song".
 */
export type NextRule = 'host' | 'anyone' | 'majority';
export const NEXT_RULES: NextRule[] = ['majority', 'anyone', 'host'];
export const nextRuleOf = (room: Pick<Room, 'nextRule'> | null): NextRule =>
  room?.nextRule && NEXT_RULES.includes(room.nextRule) ? room.nextRule : 'majority';

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
  /** Missing from hosts older than game modes: 'classic'. */
  mode?: GameMode;
  /** The bonus question while guessing, without its answer. */
  question?: PublicQuestion | null;
  /** The team whose turn it is is stealing a song the previous team missed (mode 'steal'). */
  stealing?: boolean;
  /** Power-ups used this turn (mode 'powerups'), with the decade when a hint was bought. */
  powers?: { hintDecade?: number; retry?: boolean; missedSlot?: number; attacked?: boolean };
}

/** A bonus question as phones see it: the right answer stays on the host until the reveal. */
export interface PublicQuestion {
  kind: QuestionKind;
  choices: string[];
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
  nextRule: NextRule;
}

/** Phone → host. */
export type ClientMessage =
  | { type: 'hello'; memberId: string; name: string }
  | { type: 'team'; teamId: string | null }
  | { type: 'vote'; slot: number | null }
  | { type: 'lock'; locked: boolean }
  /** Use a power-up on the team's turn (mode 'powerups'); `target` is the team an attack is aimed at. */
  | { type: 'power'; power: Power; target?: string }
  /** A vote for an answer to the bonus question (index into its choices). */
  | { type: 'answer'; choice: number | null }
  /** A new random emoji picture. */
  | { type: 'reroll' }
  | { type: 'songs'; songs: Song[] }
  /** A new name for the sender's own team. */
  | { type: 'team-name'; name: string }
  /**
   * Move on after the reveal: the next song (or the winner), or with the
   * 'majority' rule a vote for it (`want: false` takes it back). `turn` is
   * the `turnOf` the phone saw, so two taps don't skip a turn.
   */
  | { type: 'next'; turn: string; want?: boolean }
  /** Start or pause the song on the host's device. */
  | { type: 'play'; playing: boolean };

/** Something a phone asks the host's screen to do. */
export type Command = Extract<ClientMessage, { type: 'next' } | { type: 'play' }>;

/** Names one turn, for `next` messages. */
export const turnOf = (game: Pick<GameState, 'round' | 'currentPlayerIndex' | 'stealing'>) =>
  `${game.round}:${game.currentPlayerIndex}${game.stealing ? ':steal' : ''}`;

/** Host → phone. */
export type HostMessage =
  | { type: 'state'; view: RoomView }
  | { type: 'songs-added'; added: number }
  | { type: 'closed'; reason: string };

export function gameView(game: GameState | null): GameView | null {
  if (!game) return null;
  const { players, currentPlayerIndex, phase, targetCards, lastGuess, winnerIds, round } = game;
  const mode = modeOf(game);
  const q = mode === 'bonus' && phase === 'guessing' ? game.question : null;
  const question = q ? { kind: q.kind, choices: q.choices } : null;
  const pw = phase === 'guessing' ? game.powers : undefined;
  const powers = pw
    ? {
        ...(pw.hint && game.current ? { hintDecade: decadeOf(game.current.year) } : {}),
        ...(pw.retry ? { retry: true } : {}),
        ...(pw.missedSlot !== undefined ? { missedSlot: pw.missedSlot } : {}),
        ...(pw.attacked ? { attacked: true } : {}),
      }
    : undefined;
  return { players, currentPlayerIndex, phase, targetCards, lastGuess, winnerIds, round, mode, question, stealing: !!game.stealing, powers };
}

/** A power-up a member may use now: theirs is the team whose turn it is, and the message is well formed. */
export function powerRequest(room: Room, game: GameState | null, memberId: string, msg: unknown): { power: Power; target?: string } | null {
  if (!game || game.phase !== 'guessing' || modeOf(game) !== 'powerups' || !msg || typeof msg !== 'object') return null;
  const { power, target } = msg as Record<string, unknown>;
  if (typeof power !== 'string' || !POWERS.includes(power as Power)) return null;
  const member = room.members.find((m) => m.id === memberId);
  if (!member || member.teamId !== game.players[game.currentPlayerIndex]?.id) return null;
  return { power: power as Power, ...(typeof target === 'string' ? { target } : {}) };
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
    nextRule: nextRuleOf(room),
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

/** Who votes for which answer to the bonus question, as choice → member names. */
export function votesByAnswer(members: readonly Member[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const m of members) {
    if (m.answer === null || m.answer === undefined) continue;
    const names = out.get(m.answer);
    if (names) names.push(label(m));
    else out.set(m.answer, [label(m)]);
  }
  return out;
}

/** The one value with the most votes, or null when two or more share the most (or there are none). */
function mostVoted(votes: Map<number, string[]>): number | null {
  const tally = [...votes].map(([value, names]) => ({ value, n: names.length }));
  if (!tally.length) return null;
  const most = Math.max(...tally.map((t) => t.n));
  const top = tally.filter((t) => t.n === most);
  return top.length === 1 ? top[0].value : null;
}

/** The game has a bonus question for the current song. */
export const hasQuestion = (game: Pick<GameState, 'mode' | 'question' | 'phase'>) =>
  modeOf(game) === 'bonus' && game.phase === 'guessing' && !!game.question;

/** A member has voted for everything the turn asks: a spot, and an answer when there is a bonus question. */
export const readyToLock = (m: Pick<Member, 'vote' | 'answer'>, question: boolean) =>
  m.vote !== null && (!question || (m.answer !== null && m.answer !== undefined));

export type Decision =
  /** Nobody on the team has joined: the host's device decides as usual. */
  | { kind: 'none' }
  /** Some members still have to vote or lock in. */
  | { kind: 'waiting'; locked: number; total: number }
  /** Everyone locked in, but two or more spots (or bonus answers) have the most votes. */
  | { kind: 'split' }
  /** Everyone locked in: this is the team's guess, and its answer to the bonus question (null if none). */
  | { kind: 'place'; slot: number; answer: number | null };

export function teamDecision(room: Room, game: GameState): Decision {
  if (game.phase !== 'guessing') return { kind: 'none' };
  const voters = activeVoters(room, game);
  if (voters.length === 0) return { kind: 'none' };
  const question = hasQuestion(game);
  const locked = voters.filter((m) => m.locked && readyToLock(m, question)).length;
  if (locked < voters.length) return { kind: 'waiting', locked, total: voters.length };
  const slot = mostVoted(votesBySlot(voters));
  const answer = question ? mostVoted(votesByAnswer(voters)) : null;
  if (slot === null || (question && answer === null)) return { kind: 'split' };
  return { kind: 'place', slot, answer };
}

/** Everyone's votes cleared, for a new song or turn. */
export function clearVotes(room: Room): Room {
  return { ...room, members: room.members.map(({ next: _, ...m }) => ({ ...m, vote: null, answer: null, locked: false })) };
}

/** Records a member's vote for the next song after the reveal of `turn`. */
export function voteNext(room: Room, memberId: string, turn: string, want = true): Room {
  return {
    ...room,
    members: room.members.map((m) => {
      if (m.id !== memberId) return m;
      if (want) return { ...m, next: turn };
      const { next: _, ...rest } = m;
      return rest;
    }),
  };
}

/** How many connected players (not the host's device) want the next song, and how many it takes. */
export function nextVotes(members: readonly Member[], turn: string): { yes: number; needed: number } {
  const players = members.filter((m) => m.connected && m.id !== HOST_ID);
  const yes = players.filter((m) => m.next === turn).length;
  return { yes, needed: Math.floor(players.length / 2) + 1 };
}

/** The phones' majority wants the next song after this reveal. */
export function majorityWantsNext(room: Room, game: GameState): boolean {
  if (game.phase !== 'revealed' || nextRuleOf(room) !== 'majority') return false;
  const { yes, needed } = nextVotes(room.members, turnOf(game));
  return yes > 0 && yes >= needed;
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
  if (i === -1 || msg.type === 'songs' || msg.type === 'team-name' || msg.type === 'next' || msg.type === 'play' || msg.type === 'power') return room;
  const m = members[i];
  if (msg.type === 'reroll') {
    members[i] = { ...m, emoji: pickAvatar(members, Math.random, m.emoji) };
  } else if (msg.type === 'team') {
    const valid = msg.teamId === null || teams.some((t) => t.id === msg.teamId);
    if (!valid) return room;
    members[i] = { ...m, teamId: msg.teamId, vote: null, answer: null, locked: false };
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
    } else if (msg.type === 'answer') {
      const choices = hasQuestion(game) ? game.question!.choices.length : 0;
      const choice = msg.choice === null ? null : Math.trunc(msg.choice);
      if (choice !== null && !(choice >= 0 && choice < choices)) return room;
      members[i] = { ...m, answer: choice, locked: false };
    } else {
      members[i] = { ...m, locked: msg.locked && readyToLock(m, hasQuestion(game)) };
    }
  }
  return { ...room, members };
}

/** The most a team name can be. */
export const MAX_TEAM_NAME = 24;

/** A typed team name, tidied; null if nothing is left. */
export function cleanTeamName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = input.replace(/\s+/g, ' ').trim().slice(0, MAX_TEAM_NAME);
  return name || null;
}

/** The team a member may rename and its new name, or null: only members of an existing team rename it. */
export function teamRename(room: Room, teams: readonly Team[], memberId: string, name: unknown): { teamId: string; name: string } | null {
  const teamId = room.members.find((m) => m.id === memberId)?.teamId;
  const clean = cleanTeamName(name);
  if (!teamId || !clean || !teams.some((t) => t.id === teamId)) return null;
  return { teamId, name: clean };
}

/**
 * The names typed in setup with one team renamed. Lobby team ids count only
 * the names that aren't empty (see `lobbyTeams`), so blanks are skipped.
 */
export function renameLobbyTeam(names: readonly string[], teamId: string, name: string): string[] {
  const n = Number(/^p(\d+)$/.exec(teamId)?.[1]);
  let seen = 0;
  return names.map((raw) => (raw.trim() && ++seen === n ? name : raw));
}

/** The host moves a member to a team (or to none). */
export function moveMember(room: Room, memberId: string, teamId: string | null, teams: readonly Team[]): Room {
  if (teamId !== null && !teams.some((t) => t.id === teamId)) return room;
  return { ...room, members: room.members.map((m) => (m.id === memberId ? { ...m, teamId, vote: null, answer: null, locked: false } : m)) };
}

/** The host removes a member; they can't join again until let back in. Not the host itself. */
export function kickMember(room: Room, memberId: string): Room {
  const m = room.members.find((x) => x.id === memberId);
  if (!m || memberId === HOST_ID) return room;
  const kicked = [...(room.kicked ?? []).filter((k) => k.id !== memberId), { id: m.id, name: m.name }];
  return { ...room, members: room.members.filter((x) => x.id !== memberId), kicked };
}

export function letBackIn(room: Room, memberId: string): Room {
  return { ...room, kicked: (room.kicked ?? []).filter((k) => k.id !== memberId) };
}

export const isKicked = (room: Room | null, memberId: string) => !!room?.kicked?.some((k) => k.id === memberId);

/** Sent to a removed phone. A code on the wire: phones show remote.removedText from src/i18n in their own language. */
export const KICKED_REASON = 'The host removed you from the game.';

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
