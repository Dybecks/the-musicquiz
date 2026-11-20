import type { DataConnection, Peer, PeerOptions } from 'peerjs';
import { peerIdFor, type ClientMessage, type HostMessage, type RoomView } from './protocol';

/**
 * The connections between the host device and the phones. They are direct
 * WebRTC connections between the browsers (PeerJS); a PeerJS server only
 * introduces them to each other. The public PeerJS cloud server is used
 * unless VITE_PEER_HOST names another one, so the game still needs no
 * backend of its own.
 */

function peerOptions(): PeerOptions {
  const env = import.meta.env;
  if (!env.VITE_PEER_HOST) return {};
  return {
    host: env.VITE_PEER_HOST,
    port: env.VITE_PEER_PORT ? Number(env.VITE_PEER_PORT) : undefined,
    path: env.VITE_PEER_PATH || '/',
    secure: env.VITE_PEER_SECURE !== 'false',
  };
}

/** PeerJS is only loaded when a room is opened or joined. */
export async function makePeer(id?: string): Promise<Peer> {
  const { Peer } = await import('peerjs');
  return id ? new Peer(id, peerOptions()) : new Peer(peerOptions());
}

const RETRY_MS = 3000;

export type HostStatus =
  | { kind: 'opening' }
  | { kind: 'open' }
  /** Someone else has this code: the caller picks a new one. */
  | { kind: 'taken' }
  | { kind: 'error'; message: string };

export interface HostHandlers {
  onStatus: (status: HostStatus) => void;
  onMessage: (memberId: string, msg: ClientMessage) => void;
  onLeave: (memberId: string) => void;
}

export interface HostLink {
  broadcast: (msg: HostMessage) => void;
  sendTo: (memberId: string, msg: HostMessage) => void;
  /** Tells one phone it is out (it stops reconnecting) and drops its connection. */
  dismiss: (memberId: string, reason: string) => void;
  close: (reason?: string) => void;
}

/**
 * Opens a room under `code`. If the code is taken it tries again a few
 * times (this device's own room from before a reload is kept by the server
 * for a little while), and then reports it as taken.
 */
export function openHost(code: string, handlers: HostHandlers): HostLink {
  let peer: Peer | null = null;
  let closed = false;
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Open connections, by member id. */
  const conns = new Map<string, DataConnection>();

  const start = async (roomCode: string) => {
    handlers.onStatus({ kind: 'opening' });
    let p: Peer;
    try {
      p = await makePeer(peerIdFor(roomCode));
    } catch (e) {
      handlers.onStatus({ kind: 'error', message: `Couldn’t load the connection code: ${String(e)}` });
      return;
    }
    if (closed) return p.destroy();
    peer = p;
    p.on('open', () => {
      tries = 0;
      handlers.onStatus({ kind: 'open' });
    });
    p.on('connection', (conn) => {
      let memberId: string | null = null;
      conn.on('data', (data) => {
        const msg = data as ClientMessage;
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
        if (msg.type === 'hello') {
          if (typeof msg.memberId !== 'string' || !msg.memberId) return;
          memberId = msg.memberId.slice(0, 40);
          const old = conns.get(memberId);
          if (old && old !== conn) old.close();
          conns.set(memberId, conn);
        }
        if (memberId) handlers.onMessage(memberId, msg);
      });
      const gone = () => {
        if (memberId && conns.get(memberId) === conn) {
          conns.delete(memberId);
          handlers.onLeave(memberId);
        }
      };
      conn.on('close', gone);
      conn.on('error', gone);
    });
    // Lost the PeerJS server (not the phones): reconnect so new phones can still join.
    p.on('disconnected', () => {
      if (!closed && !p.destroyed) timer = setTimeout(() => !closed && !p.destroyed && p.reconnect(), RETRY_MS);
    });
    p.on('error', (err) => {
      if (closed) return;
      if (err.type === 'unavailable-id') {
        p.destroy();
        if (++tries > 3) handlers.onStatus({ kind: 'taken' });
        else timer = setTimeout(() => void start(roomCode), RETRY_MS);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        handlers.onStatus({ kind: 'error', message: 'Can’t reach the connection server. Retrying…' });
        p.destroy();
        timer = setTimeout(() => void start(roomCode), RETRY_MS * 2);
      } else if (err.type === 'browser-incompatible') {
        handlers.onStatus({ kind: 'error', message: 'This browser can’t share the game (no WebRTC).' });
      }
    });
  };

  void start(code);

  return {
    broadcast(msg) {
      for (const conn of conns.values()) if (conn.open) conn.send(msg);
    },
    sendTo(memberId, msg) {
      const conn = conns.get(memberId);
      if (conn?.open) conn.send(msg);
    },
    dismiss(memberId, reason) {
      const conn = conns.get(memberId);
      if (!conn) return;
      conns.delete(memberId);
      if (conn.open) conn.send({ type: 'closed', reason } satisfies HostMessage);
      // Give the goodbye a moment to go out.
      setTimeout(() => conn.close(), 300);
    },
    close(reason = 'The host ended the game.') {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      let said = false;
      for (const conn of conns.values()) {
        if (!conn.open) continue;
        conn.send({ type: 'closed', reason } satisfies HostMessage);
        said = true;
      }
      // Give the goodbye a moment to go out.
      const p = peer;
      if (said) setTimeout(() => p?.destroy(), 300);
      else p?.destroy();
    },
  };
}

export type ClientStatus =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'reconnecting' }
  | { kind: 'not-found' }
  | { kind: 'closed'; reason: string }
  | { kind: 'error'; message: string };

export interface ClientHandlers {
  onStatus: (status: ClientStatus) => void;
  onView: (view: RoomView) => void;
  /** The host added songs this phone sent. */
  onSongsAdded?: (added: number) => void;
}

export interface ClientLink {
  send: (msg: ClientMessage) => void;
  close: () => void;
}

/**
 * Joins the room `code`. Once joined, a lost connection is retried until
 * `close` is called, so a host reload or a phone going to sleep is survived.
 */
export function joinRoom(code: string, memberId: string, name: string, handlers: ClientHandlers): ClientLink {
  let peer: Peer | null = null;
  let conn: DataConnection | null = null;
  let closed = false;
  let joined = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const retry = () => {
    if (closed) return;
    clearTimeout(timer);
    handlers.onStatus({ kind: 'reconnecting' });
    timer = setTimeout(connect, RETRY_MS);
  };

  const connect = () => {
    if (closed || !peer || peer.destroyed) return;
    if (peer.disconnected) {
      peer.reconnect();
      return; // 'open' fires again and connects.
    }
    conn?.close();
    const c = peer.connect(peerIdFor(code), { reliable: true, serialization: 'json' });
    conn = c;
    c.on('open', () => {
      joined = true;
      handlers.onStatus({ kind: 'connected' });
      c.send({ type: 'hello', memberId, name } satisfies ClientMessage);
    });
    c.on('data', (data) => {
      const msg = data as HostMessage;
      if (msg?.type === 'state') handlers.onView(msg.view);
      else if (msg?.type === 'songs-added') handlers.onSongsAdded?.(msg.added);
      else if (msg?.type === 'closed') {
        closed = true;
        handlers.onStatus({ kind: 'closed', reason: msg.reason });
        peer?.destroy();
      }
    });
    c.on('close', () => conn === c && retry());
    c.on('error', () => conn === c && retry());
  };

  const setupPeer = async () => {
    let p: Peer;
    try {
      p = await makePeer();
    } catch (e) {
      handlers.onStatus({ kind: 'error', message: `Couldn’t load the connection code: ${String(e)}` });
      return;
    }
    if (closed) return p.destroy();
    peer = p;
    p.on('open', connect);
    p.on('disconnected', retry);
    p.on('error', (err) => {
      if (closed || peer !== p) return;
      if (err.type === 'peer-unavailable' && !joined) {
        closed = true;
        handlers.onStatus({ kind: 'not-found' });
        p.destroy();
      } else if (err.type === 'browser-incompatible') {
        closed = true;
        handlers.onStatus({ kind: 'error', message: 'This browser can’t join (no WebRTC).' });
      } else if (p.destroyed) {
        // This peer is gone for good: start over with a new one.
        handlers.onStatus({ kind: 'reconnecting' });
        clearTimeout(timer);
        timer = setTimeout(() => void setupPeer(), RETRY_MS);
      } else {
        retry();
      }
    });
  };

  handlers.onStatus({ kind: 'connecting' });
  void setupPeer();

  return {
    send(msg) {
      if (conn?.open) conn.send(msg);
    },
    close() {
      closed = true;
      clearTimeout(timer);
      conn?.close();
      peer?.destroy();
    },
  };
}
