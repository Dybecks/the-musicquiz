import { describe, expect, it } from 'vitest';
import { createGame, type GameState, type Song } from '../game/engine';
import {
  applyMessage,
  clearVotes,
  gameView,
  isValidCode,
  newRoomCode,
  normalizeCode,
  roomView,
  setConnected,
  teamDecision,
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
    expect(teamDecision(room, g)).toEqual({ kind: 'place', slot: 1 });
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
    expect(teamDecision(room, g)).toEqual({ kind: 'place', slot: 1 });
    expect(votesBySlot(room.members).get(1)).toEqual(['ann']);
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
