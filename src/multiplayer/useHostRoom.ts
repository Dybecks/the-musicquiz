import { useCallback, useEffect, useRef, useState } from 'react';
import { placeCurrent, type GameState } from '../game/engine';
import { openHost, type HostLink, type HostStatus } from './connection';
import {
  applyMessage,
  clearVotes,
  newRoomCode,
  roomView,
  setConnected,
  teamDecision,
  type Decision,
  type Room,
} from './protocol';

const ROOM_KEY = 'mq.room';

function loadRoom(): Room | null {
  try {
    const room = JSON.parse(localStorage.getItem(ROOM_KEY) ?? 'null') as Room | null;
    // After a reload nobody is connected until their phone reconnects.
    return room?.code ? { ...room, members: room.members.map((m) => ({ ...m, connected: false, locked: false })) } : null;
  } catch {
    return null;
  }
}

export interface HostRoom {
  room: Room | null;
  status: HostStatus | null;
  decision: Decision;
  /** Opens a room with a new code. */
  share: () => void;
  /** Closes the room and tells the phones. */
  stop: (reason?: string) => void;
}

/**
 * The host side of shared play, used by the game screen. Keeps the room
 * (members, teams, votes), sends every change to the phones, and places the
 * team's guess once all its members have locked in.
 */
export function useHostRoom(game: GameState, onChange: (s: GameState) => void): HostRoom {
  const [room, setRoom] = useState<Room | null>(loadRoom);
  const [status, setStatus] = useState<HostStatus | null>(null);
  const link = useRef<HostLink | null>(null);
  const latestGame = useRef(game);
  latestGame.current = game;
  const code = room?.code ?? null;

  // Open the connection for the room's code (also after a reload).
  useEffect(() => {
    if (!code) return;
    const l = openHost(code, {
      onStatus: (s) => {
        setStatus(s);
        if (s.kind === 'taken') setRoom((r) => (r ? { ...r, code: newRoomCode() } : r));
      },
      onMessage: (memberId, msg) => setRoom((r) => (r ? applyMessage(r, latestGame.current, memberId, msg) : r)),
      onLeave: (memberId) => setRoom((r) => (r ? setConnected(r, memberId, false) : r)),
    });
    link.current = l;
    return () => {
      l.close();
      if (link.current === l) link.current = null;
    };
  }, [code]);

  useEffect(() => {
    if (room) localStorage.setItem(ROOM_KEY, JSON.stringify(room));
    else localStorage.removeItem(ROOM_KEY);
  }, [room]);

  // A new song or a new turn: everyone votes afresh.
  const turnKey = `${game.round}:${game.currentPlayerIndex}:${game.phase}:${game.current?.id ?? ''}`;
  const lastTurn = useRef(turnKey);
  useEffect(() => {
    if (lastTurn.current === turnKey) return;
    lastTurn.current = turnKey;
    setRoom((r) => (r ? clearVotes(r) : r));
  }, [turnKey]);

  const decision: Decision = room ? teamDecision(room, game) : { kind: 'none' };

  // The whole team locked in: that's the guess.
  useEffect(() => {
    if (decision.kind === 'place') onChange(placeCurrent(game, decision.slot));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision.kind === 'place' ? decision.slot : null, decision.kind]);

  // Keep every phone up to date.
  useEffect(() => {
    if (room && status?.kind === 'open') link.current?.broadcast({ type: 'state', view: roomView(room, game) });
  }, [room, game, status]);

  const share = useCallback(() => setRoom((r) => r ?? { code: newRoomCode(), members: [] }), []);
  const stop = useCallback((reason?: string) => {
    link.current?.close(reason);
    link.current = null;
    setRoom(null);
    setStatus(null);
  }, []);

  return { room, status, decision, share, stop };
}
