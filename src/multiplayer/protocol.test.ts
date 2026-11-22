import { describe, expect, it } from 'vitest';
import { applyPower, createGame, placeCurrent, type GameState, type Song } from '../game/engine';
import {
  AVATARS,
  HOST_ID,
  applyMessage,
  isKicked,
  kickMember,
  majorityWantsNext,
  nextVotes,
  turnOf,
  voteNext,
  letBackIn,
  moveMember,
  renameLobbyTeam,
  teamRename,
  cleanSongs,
  dropMissingTeams,
  lobbyTeams,
  clearVotes,
  gameView,
  isValidCode,
  newRoomCode,
  normalizeCode,
  roomView,
  setConnected,
  teamDecision,
  powerRequest,
  votesBySlot,
  type Room,
} from './protocol';

const songs: Song[] = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, title: `Song ${i}`, artist: 'A', year: 1960 + i * 3 }));
const game = (): GameState => createGame({ playerNames: ['Red', 'Blue'], targetCards: 5, songs, rng: () => 0.5 });

function roomWith(g: GameState, ...members: [id: string, team: string | null][]): Room {
  let room: Room = { code: 'ABCD', members: [] };
  for (const [id, team] of members) {
    room = applyMessage(room, g, id, { type: 'hello', memberId: id, name: id });
    room = applyMessage(room, g, id, { type: 'team', teamId: team });
  }
  return room;
}

describe('room codes', () => {
  it('makes valid codes and tidies typed ones', () => {
    for (let i = 0; i < 50; i++) expect(isValidCode(newRoomCode())).toBe(true);
    expect(normalizeCode(' ab-cd ')).toBe('ABCD');
    expect(isValidCode('AB0D')).toBe(false); // 0 is left out, it looks like O
  });
});

describe('votes', () => {
  it('only lets the team whose turn it is vote, on a real slot', () => {
    const g = game();
    let room = roomWith(g, ['ann', 'p1'], ['bob', 'p2']);
    room = applyMessage(room, g, 'ann', { type: 'vote', slot: 1 });
    room = applyMessage(room, g, 'bob', { type: 'vote', slot: 0 });
    room = applyMessage(room, g, 'ann', { type: 'vote', slot: 99 });
    expect(room.members.map((m) => m.vote)).toEqual([1, null]);
  });

  it('ignores a team that is not in the game', () => {
    const g = game();
    const room = roomWith(g, ['ann', 'nope']);
    expect(room.members[0].teamId).toBeNull();
  });

  it('waits until every connected member has locked in, then places the most voted spot', () => {
    const g = game();
    let room = roomWith(g, ['ann', 'p1'], ['bob', 'p1'], ['cid', 'p1']);
    expect(teamDecision(room, g)).toEqual({ kind: 'waiting', locked: 0, total: 3 });
    room = applyMessage(room, g, 'ann', { type: 'vote', slot: 1 });
    room = applyMessage(room, g, 'ann', { type: 'lock', locked: true });
    room = applyMessage(room, g, 'bob', { type: 'vote', slot: 1 });
    room = applyMessage(room, g, 'bob', { type: 'lock', locked: true });
    room = applyMessage(room, g, 'cid', { type: 'lock', locked: true }); // no vote yet: can't lock
    expect(teamDecision(room, g)).toEqual({ kind: 'waiting', locked: 2, total: 3 });
    room = applyMessage(room, g, 'cid', { type: 'vote', slot: 0 });
    room = applyMessage(room, g, 'cid', { type: 'lock', locked: true });
    expect(teamDecision(room, g)).toEqual({ kind: 'place', slot: 1, answer: null });
  });

  it('reports a split vote instead of guessing', () => {
    const g = game();
    let room = roomWith(g, ['ann', 'p1'], ['bob', 'p1']);
    for (const [id, slot] of [['ann', 0], ['bob', 1]] as const) {
      room = applyMessage(room, g, id, { type: 'vote', slot });
      room = applyMessage(room, g, id, { type: 'lock', locked: true });
    }
    expect(teamDecision(room, g)).toEqual({ kind: 'split' });
    expect(roomView(room, g).split).toBe(true);
    // Changing a vote unlocks it.
    room = applyMessage(room, g, 'bob', { type: 'vote', slot: 0 });
    expect(teamDecision(room, g)).toEqual({ kind: 'waiting', locked: 1, total: 2 });
  });

  it("doesn't wait for members who dropped out", () => {
    const g = game();
    let room = roomWith(g, ['ann', 'p1'], ['bob', 'p1']);
    room = applyMessage(room, g, 'ann', { type: 'vote', slot: 1 });
    room = applyMessage(room, g, 'ann', { type: 'lock', locked: true });
    room = setConnected(room, 'bob', false);
    expect(teamDecision(room, g)).toEqual({ kind: 'place', slot: 1, answer: null });
    expect(votesBySlot(room.members).get(1)).toEqual([`${room.members[0].emoji} ann`]);
  });

  it('leaves the decision to the host when nobody on the team has joined', () => {
    const g = game();
    expect(teamDecision(roomWith(g, ['bob', 'p2']), g)).toEqual({ kind: 'none' });
  });

  it('clears votes for a new turn', () => {
    const g = game();
    let room = roomWith(g, ['ann', 'p1']);
    room = applyMessage(room, g, 'ann', { type: 'vote', slot: 1 });
    room = clearVotes(room);
    expect(room.members[0]).toMatchObject({ vote: null, locked: false, teamId: 'p1' });
  });
});

describe('what phones see', () => {
  it('never includes the song that is playing or the deck', () => {
    const g = game();
    const view = gameView(g)!;
    expect(JSON.stringify(view)).not.toContain(`"${g.current!.id}"`);
    expect(view).not.toHaveProperty('deck');
    expect(view).not.toHaveProperty('current');
  });
});

describe('before the game starts', () => {
  it('lets people pick a team from the names typed in setup, with the ids the game will use', () => {
    const teams = lobbyTeams(['Red', ' ', 'Blue']);
    expect(teams).toEqual([
      { id: 'p1', name: 'Red' },
      { id: 'p2', name: 'Blue' },
    ]);
    let room: Room = { code: 'ABCD', members: [] };
    room = applyMessage(room, null, 'ann', { type: 'hello', memberId: 'ann', name: 'Ann' }, teams);
    room = applyMessage(room, null, 'ann', { type: 'team', teamId: 'p2' }, teams);
    expect(room.members[0].teamId).toBe('p2');
    // Same ids as createGame gives the players.
    const g = createGame({ playerNames: ['Red', 'Blue'], targetCards: 5, songs });
    expect(g.players.map((p) => p.id)).toEqual(['p1', 'p2']);
    // The team is removed in setup: choose again.
    room = dropMissingTeams(room, lobbyTeams(['Red']));
    expect(room.members[0].teamId).toBeNull();
  });
});

describe('profile pictures', () => {
  it('gives everyone a different emoji, and a new one on request', () => {
    const g = game();
    const room = roomWith(g, ['ann', 'p1'], ['bob', 'p1'], ['cid', 'p2']);
    const emojis = room.members.map((m) => m.emoji);
    expect(emojis.every((e) => e && AVATARS.includes(e))).toBe(true);
    expect(new Set(emojis).size).toBe(3);
    const after = applyMessage(room, g, 'ann', { type: 'reroll' });
    expect(after.members[0].emoji).not.toBe(emojis[0]);
    // Reconnecting keeps the picture.
    const again = applyMessage(after, g, 'ann', { type: 'hello', memberId: 'ann', name: 'Ann' });
    expect(again.members[0].emoji).toBe(after.members[0].emoji);
  });
});

describe('songs from phones', () => {
  it('keeps only well-formed songs', () => {
    const out = cleanSongs([
      { id: 'sp:1', title: 'Song', artist: 'Band', year: 1984, spotifyId: '4uLU6hMCjMI75M1A2tKUQC' },
      { title: 'No year', artist: 'Band' },
      { title: 'Bad id', artist: 'Band', year: 1990, spotifyId: '../../x' },
      'nonsense',
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]).not.toHaveProperty('spotifyId');
    expect(cleanSongs('nope')).toEqual([]);
  });
});

describe('the host managing the room', () => {
  const teams = [
    { id: 'p1', name: 'Red' },
    { id: 'p2', name: 'Blue' },
  ];

  it('moves a member to another team, clearing their vote', () => {
    let room = roomWith(game(), ['a', 'p1']);
    room = applyMessage(room, game(), 'a', { type: 'vote', slot: 0 });
    room = moveMember(room, 'a', 'p2', teams);
    expect(room.members[0]).toMatchObject({ teamId: 'p2', vote: null, locked: false });
    expect(moveMember(room, 'a', 'nope', teams)).toBe(room);
  });

  it('removes a member, remembers them until let back in, and never removes the host', () => {
    let room = roomWith(game(), ['a', 'p1'], ['b', 'p2']);
    room = kickMember(room, 'a');
    expect(room.members.map((m) => m.id)).toEqual(['b']);
    expect(isKicked(room, 'a')).toBe(true);
    expect(isKicked(letBackIn(room, 'a'), 'a')).toBe(false);
    const withHost = roomWith(game(), [HOST_ID, 'p1']);
    expect(kickMember(withHost, HOST_ID)).toBe(withHost);
  });

  it('lets only a team’s own members rename it, with a tidy name', () => {
    const room = roomWith(game(), ['a', 'p1'], ['b', null]);
    expect(teamRename(room, teams, 'a', '  The   Rockers ')).toEqual({ teamId: 'p1', name: 'The Rockers' });
    expect(teamRename(room, teams, 'b', 'Sneaky')).toBeNull();
    expect(teamRename(room, teams, 'a', '   ')).toBeNull();
    expect(teamRename(room, teams, 'a', 'x'.repeat(50))?.name).toHaveLength(24);
  });

  it('renames the right setup name, skipping blank ones', () => {
    expect(renameLobbyTeam(['Red', '', 'Blue'], 'p2', 'Green')).toEqual(['Red', '', 'Green']);
    expect(lobbyTeams(renameLobbyTeam(['Red', '', 'Blue'], 'p2', 'Green'))[1]).toEqual({ id: 'p2', name: 'Green' });
  });
});

describe('moving on after the reveal', () => {
  const revealed = () => placeCurrent(game(), 0);

  it('goes on when more than half of the connected players want to', () => {
    const g = revealed();
    const turn = turnOf(g);
    let room = roomWith(g, [HOST_ID, 'p1'], ['a', 'p1'], ['b', 'p2'], ['c', null]);
    room = voteNext(room, 'a', turn);
    expect(nextVotes(room.members, turn)).toEqual({ yes: 1, needed: 2 });
    expect(majorityWantsNext(room, g)).toBe(false);
    room = voteNext(room, 'b', turn);
    expect(majorityWantsNext(room, g)).toBe(true);
    // Taken back, or the rule changed: no.
    expect(majorityWantsNext(voteNext(room, 'b', turn, false), g)).toBe(false);
    expect(majorityWantsNext({ ...room, nextRule: 'host' }, g)).toBe(false);
  });

  it('ignores votes for an earlier turn and players who left', () => {
    const g = revealed();
    let room = roomWith(g, ['a', 'p1'], ['b', 'p2']);
    room = voteNext(room, 'a', 'old');
    expect(majorityWantsNext(room, g)).toBe(false);
    room = setConnected(voteNext(room, 'a', turnOf(g)), 'b', false);
    expect(majorityWantsNext(room, g)).toBe(true);
    expect(clearVotes(room).members.every((m) => m.next === undefined)).toBe(true);
  });
});

describe('bonus question votes', () => {
  const bands: Song[] = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, title: `Song ${i}`, artist: `Band ${i}`, year: 1960 + i * 3 }));
  const bonusGame = () => createGame({ playerNames: ['Red', 'Blue'], targetCards: 5, songs: bands, mode: 'bonus' });

  it('shows phones the question but not the answer', () => {
    const g = bonusGame();
    const view = gameView(g)!;
    expect(view.question?.choices).toEqual(g.question!.choices);
    expect(view.question).not.toHaveProperty('answer');
  });

  it('needs a spot and an answer to lock in, then places both', () => {
    const g = bonusGame();
    let room = roomWith(g, ['ann', 'p1'], ['bob', 'p1']);
    room = applyMessage(room, g, 'ann', { type: 'vote', slot: 1 });
    room = applyMessage(room, g, 'ann', { type: 'lock', locked: true });
    expect(room.members[0].locked).toBe(false);
    room = applyMessage(room, g, 'ann', { type: 'answer', choice: 2 });
    room = applyMessage(room, g, 'ann', { type: 'lock', locked: true });
    room = applyMessage(room, g, 'bob', { type: 'vote', slot: 1 });
    room = applyMessage(room, g, 'bob', { type: 'answer', choice: 2 });
    room = applyMessage(room, g, 'bob', { type: 'lock', locked: true });
    expect(teamDecision(room, g)).toEqual({ kind: 'place', slot: 1, answer: 2 });
  });

  it('rejects answers that are not among the choices, and splits on a tie', () => {
    const g = bonusGame();
    let room = roomWith(g, ['ann', 'p1'], ['bob', 'p1']);
    room = applyMessage(room, g, 'ann', { type: 'answer', choice: 9 });
    expect(room.members[0].answer ?? null).toBeNull();
    for (const [id, choice] of [['ann', 0], ['bob', 1]] as const) {
      room = applyMessage(room, g, id, { type: 'vote', slot: 0 });
      room = applyMessage(room, g, id, { type: 'answer', choice });
      room = applyMessage(room, g, id, { type: 'lock', locked: true });
    }
    expect(teamDecision(room, g)).toEqual({ kind: 'split' });
    // Changing the answer unlocks.
    room = applyMessage(room, g, 'bob', { type: 'answer', choice: 0 });
    expect(room.members[1].locked).toBe(false);
  });

  it('ignores answers in classic', () => {
    const g = game();
    const room = applyMessage(roomWith(g, ['ann', 'p1']), g, 'ann', { type: 'answer', choice: 0 });
    expect(room.members[0].answer ?? null).toBeNull();
  });
});

describe('power-ups from phones', () => {
  const pg = () => createGame({ playerNames: ['Red', 'Blue'], targetCards: 5, songs, mode: 'powerups' });

  it('lets only the team whose turn it is use a known power-up', () => {
    const g = pg();
    const room = roomWith(g, ['ann', 'p1'], ['bob', 'p2']);
    expect(powerRequest(room, g, 'ann', { type: 'power', power: 'hint' })).toEqual({ power: 'hint' });
    expect(powerRequest(room, g, 'ann', { type: 'power', power: 'freeze', target: 'p2' })).toEqual({ power: 'freeze', target: 'p2' });
    expect(powerRequest(room, g, 'bob', { type: 'power', power: 'hint' })).toBeNull();
    expect(powerRequest(room, g, 'ann', { type: 'power', power: 'nuke' })).toBeNull();
    expect(powerRequest(room, game(), 'ann', { type: 'power', power: 'hint' })).toBeNull();
  });

  it('shows phones the hint decade only once bought', () => {
    const g = pg();
    expect(gameView(g)!.powers).toBeUndefined();
    const hinted = applyPower(g, 'hint');
    expect(gameView(hinted)!.powers?.hintDecade).toBe(Math.floor(g.current!.year / 10) * 10);
  });
});
