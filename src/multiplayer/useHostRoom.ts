import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { addSongs, placeCurrent, type GameState, type Song } from '../game/engine';
import { mergeSongs } from '../spotify/personalDeck';
import { openHost, type HostLink, type HostStatus } from './connection';
import {
  HOST_ID,
  NO_LIVE,
  applyMessage,
  cleanSongs,
  clearVotes,
  countSongs,
  dropMissingTeams,
  newRoomCode,
  pickAvatar,
  roomView,
  setConnected,
  teamDecision,
  teamsOf,
  type ClientMessage,
  type Decision,
  type Live,
  type Room,
  type Team,
} from './protocol';
import { msg as texts } from '../i18n';

const ROOM_KEY = 'mq.room';
const HOST_NAME_KEY = 'mq.hostName';

function loadRoom(): Room | null {
  try {
    const room = JSON.parse(localStorage.getItem(ROOM_KEY) ?? 'null') as Room | null;
    // After a reload nobody but the host is connected until their phone reconnects.
    return room?.code
      ? { ...room, members: room.members.map((m) => ({ ...m, connected: m.id === HOST_ID, locked: false })) }
      : null;
  } catch {
    return null;
  }
}

export interface HostRoom {
  room: Room | null;
  status: HostStatus | null;
  decision: Decision;
  teams: Team[];
  /** Opens a room with a new code. */
  share: () => void;
  /** Closes the room and tells the phones. */
  stop: (reason?: string) => void;
  /** The host's own device as a member: choose a team, vote, lock in, change name. */
  act: (msg: ClientMessage) => void;
  /** What the host's screen shows right now (song playing, tapped spot), for the phones. */
  setLive: (live: Live) => void;
  /** Takes the songs phones sent before the start, to put in the new game's deck. */
  takePending: () => Song[];
}

/**
 * The host side of shared play. Lives for as long as the room is open: in
 * setup (the lobby), through the game and on to the next one. Keeps the room
 * (members, teams, votes), sends every change to all phones as it happens,
 * places the team's guess once all its members have locked in, and adds the
 * songs phones send.
 */
export function useHostRoom(game: GameState | null, setGame: Dispatch<SetStateAction<GameState | null>>, lobby: Team[]): HostRoom {
  const [room, setRoom] = useState<Room | null>(loadRoom);
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [live, setLiveState] = useState<Live>(NO_LIVE);
  const link = useRef<HostLink | null>(null);
  const teams = useMemo(() => teamsOf(game, lobby), [game, lobby]);
  const latest = useRef({ game, teams, room });
  latest.current = { game, teams, room };
  const code = room?.code ?? null;

  const receiveSongs = useCallback(
    (memberId: string, raw: unknown) => {
      const songs = cleanSongs(raw);
      if (songs.length === 0) return;
      const g = latest.current.game;
      let added: number;
      if (g && g.phase !== 'finished') {
        const next = addSongs(g, songs, g.refill);
        added = next.deck.length - g.deck.length;
        // Put the new songs into the deck the game has now, even if it moved on meanwhile.
        setGame((cur) => (cur && cur.phase !== 'finished' ? addSongs(cur, songs, cur.refill) : cur));
      } else {
        const pending = latest.current.room?.pending ?? [];
        added = mergeSongs(pending, songs).length - pending.length;
        setRoom((r) => (r ? { ...r, pending: mergeSongs(r.pending ?? [], songs) } : r));
      }
      setRoom((r) => (r ? countSongs(r, memberId, added) : r));
      link.current?.sendTo(memberId, { type: 'songs-added', added });
    },
    [setGame],
  );

  // Open the connection for the room's code (also after a reload).
  useEffect(() => {
    if (!code) return;
    const l = openHost(code, {
      onStatus: (s) => {
        setStatus(s);
        if (s.kind === 'taken') setRoom((r) => (r ? { ...r, code: newRoomCode() } : r));
      },
      onMessage: (memberId, msg) => {
        if (memberId === HOST_ID) return; // A phone can't pretend to be the host.
        if (msg.type === 'songs') return receiveSongs(memberId, msg.songs);
        setRoom((r) => (r ? applyMessage(r, latest.current.game, memberId, msg, latest.current.teams) : r));
      },
      onLeave: (memberId) => setRoom((r) => (r ? setConnected(r, memberId, false) : r)),
    });
    link.current = l;
    return () => {
      l.close();
      if (link.current === l) link.current = null;
    };
  }, [code, receiveSongs]);

  useEffect(() => {
    if (room) localStorage.setItem(ROOM_KEY, JSON.stringify(room));
    else localStorage.removeItem(ROOM_KEY);
  }, [room]);

  // A team removed in setup: its members choose again.
  useEffect(() => {
    setRoom((r) => (r ? dropMissingTeams(r, teams) : r));
  }, [teams]);

  // A new song, turn or game: everyone votes afresh.
  const turnKey = game ? `${game.round}:${game.currentPlayerIndex}:${game.phase}:${game.current?.id ?? ''}` : 'lobby';
  const lastTurn = useRef(turnKey);
  useEffect(() => {
    if (lastTurn.current === turnKey) return;
    lastTurn.current = turnKey;
    setRoom((r) => (r ? clearVotes(r) : r));
  }, [turnKey]);

  const decision: Decision = room && game ? teamDecision(room, game) : { kind: 'none' };

  // The whole team locked in: that's the guess.
  const placeSlot = decision.kind === 'place' ? decision.slot : null;
  useEffect(() => {
    if (placeSlot === null) return;
    setGame((g) => (g && g.phase === 'guessing' ? placeCurrent(g, placeSlot) : g));
  }, [placeSlot, turnKey, setGame]);

  // Every change goes to every phone right away.
  useEffect(() => {
    if (room && status?.kind === 'open') link.current?.broadcast({ type: 'state', view: roomView(room, game, teams, live) });
  }, [room, game, teams, live, status]);

  const share = useCallback(
    () =>
      setRoom(
        (r) =>
          r ?? {
            code: newRoomCode(),
            members: [
              {
                id: HOST_ID,
                name: localStorage.getItem(HOST_NAME_KEY) || texts().app.defaultHost,
                teamId: null,
                connected: true,
                vote: null,
                locked: false,
                emoji: pickAvatar([]),
              },
            ],
          },
      ),
    [],
  );

  const stop = useCallback((reason?: string) => {
    link.current?.close(reason);
    link.current = null;
    setRoom(null);
    setStatus(null);
  }, []);

  const act = useCallback((msg: ClientMessage) => {
    if (msg.type === 'hello') localStorage.setItem(HOST_NAME_KEY, msg.name.trim());
    setRoom((r) => {
      if (!r) return r;
      // Rooms from before the host could be a member get one.
      const withHost = r.members.some((m) => m.id === HOST_ID)
        ? r
        : applyMessage(r, null, HOST_ID, { type: 'hello', memberId: HOST_ID, name: localStorage.getItem(HOST_NAME_KEY) || texts().app.defaultHost });
      return applyMessage(withHost, latest.current.game, HOST_ID, msg, latest.current.teams);
    });
  }, []);

  const setLive = useCallback(
    (next: Live) => setLiveState((cur) => (cur.playing === next.playing && cur.hostPick === next.hostPick ? cur : next)),
    [],
  );

  const takePending = useCallback(() => {
    const songs = room?.pending ?? [];
    if (songs.length) setRoom((r) => (r ? { ...r, pending: [] } : r));
    return songs;
  }, [room]);

  return { room, status, decision, teams, share, stop, act, setLive, takePending };
}
