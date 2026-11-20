import type { DataConnection, Peer } from 'peerjs';
import { makePeer } from '../multiplayer/connection';
import { msg as texts } from '../i18n';

/**
 * The link to the Sonos bridge (bridge/ in this repository): a small program
 * on a computer on the home network that controls the Sonos speakers. The
 * game reaches it over WebRTC like the phones, by its six-letter speaker code.
 */

export interface SonosSpeaker {
  id: string;
  name: string;
}

/** The bridge the host connected to, and the speaker (group) chosen on it. */
export interface SonosChoice {
  code: string;
  speaker: SonosSpeaker;
}

/** Must match peerId() in bridge/index.js. */
export const bridgePeerId = (code: string) => `the-musicquiz-speaker-${code.toLowerCase()}`;

export const normalizeBridgeCode = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
export const isBridgeCode = (s: string) => /^[A-Z]{6}$/.test(s);

/** A saved choice, if it has the right shape. */
export function parseSonosChoice(v: unknown): SonosChoice | null {
  const c = v as SonosChoice | null;
  if (!c || typeof c !== 'object' || typeof c.code !== 'string' || !isBridgeCode(c.code)) return null;
  if (!c.speaker || typeof c.speaker.id !== 'string' || typeof c.speaker.name !== 'string') return null;
  return { code: c.code, speaker: { id: c.speaker.id, name: c.speaker.name } };
}

/** The bridge version this game speaks to. */
const VERSION = 1;

type Reply = { type: 'reply'; id: number; ok: boolean; error?: string; speakers?: SonosSpeaker[]; version?: number };
type BridgeMessage = Reply | { type: 'state'; speakerId: string; playing: boolean };

export interface BridgeLink {
  /** Connect (if needed) and check that the bridge answers. */
  check(): Promise<void>;
  list(): Promise<SonosSpeaker[]>;
  play(speakerId: string, uri: string): Promise<void>;
  resume(speakerId: string): Promise<void>;
  pause(speakerId: string): Promise<void>;
  onState(cb: (speakerId: string, playing: boolean) => void): void;
  close(): void;
}

const CONNECT_MS = 12000;
const REPLY_MS = 15000;

interface Pending {
  resolve: (r: Reply) => void;
  reject: (e: Error) => void;
}

/**
 * Connect to the bridge with `code`. Each request waits for the connection,
 * and a dropped connection is made again on the next request.
 */
export function connectBridge(code: string): BridgeLink {
  let peer: Peer | null = null;
  let peerReady: Promise<Peer> | null = null;
  /** The current connection, and the requests waiting for its replies. */
  let current: { conn: Promise<DataConnection>; pending: Map<number, Pending> } | null = null;
  let closed = false;
  let nextId = 1;
  let stateListener: (speakerId: string, playing: boolean) => void = () => {};

  const failAll = (pending: Map<number, Pending>, e: Error) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };

  /** A peer that is connected to the PeerJS server. A dropped one is replaced. */
  const getPeer = (): Promise<Peer> => {
    if (peer && !peer.destroyed && !peer.disconnected && peerReady) return peerReady;
    peer?.destroy();
    peer = null;
    peerReady = (async () => {
      const p = await makePeer();
      peer = p;
      await new Promise<void>((ok, fail) => {
        const timer = setTimeout(() => fail(new Error(texts().errors.serverUnreachable)), CONNECT_MS);
        p.once('open', () => {
          clearTimeout(timer);
          ok();
        });
        p.once('error', (err) => {
          clearTimeout(timer);
          fail(new Error(texts().errors.serverUnreachableType(err.type)));
        });
      });
      return p;
    })();
    peerReady.catch(() => {
      peerReady = null;
    });
    return peerReady;
  };

  const open = (pending: Map<number, Pending>): Promise<DataConnection> =>
    getPeer().then(
      (p) =>
        new Promise<DataConnection>((resolve, reject) => {
          const c = p.connect(bridgePeerId(code), { reliable: true, serialization: 'json' });
          if (!c) return reject(new Error(texts().errors.serverUnreachable));
          let settled = false;
          const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            p.off('error', onPeerError);
            if (err) {
              c.close();
              reject(err);
            } else resolve(c);
          };
          const timer = setTimeout(() => finish(new Error(texts().errors.bridgeNotFound)), CONNECT_MS);
          const onPeerError = (err: { type: string }) => {
            if (err.type === 'peer-unavailable') finish(new Error(texts().errors.bridgeNotFound));
          };
          p.on('error', onPeerError);
          c.on('open', () => finish());
          c.on('data', (data) => {
            const msg = data as BridgeMessage;
            if (msg?.type === 'reply') {
              const waiting = pending.get(msg.id);
              pending.delete(msg.id);
              waiting?.resolve(msg);
            } else if (msg?.type === 'state') stateListener(msg.speakerId, msg.playing);
          });
          const lost = () => {
            finish(new Error(texts().errors.bridgeLost));
            // Only forget the connection if it is still the current one.
            if (current?.pending === pending) current = null;
            failAll(pending, new Error(texts().errors.bridgeLost));
          };
          c.on('close', lost);
          c.on('error', lost);
        }),
    );

  const request = async (msg: Record<string, unknown>): Promise<Reply> => {
    if (closed) throw new Error(texts().errors.bridgeClosed);
    if (!current) {
      const pending = new Map<number, Pending>();
      const entry = { conn: open(pending), pending };
      current = entry;
      entry.conn.catch(() => {
        if (current === entry) current = null;
      });
    }
    const { conn, pending } = current;
    const c = await conn;
    const id = nextId++;
    const reply = new Promise<Reply>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(texts().errors.bridgeTimeout));
      }, REPLY_MS);
    });
    c.send({ ...msg, id });
    const r = await reply;
    if (!r.ok) throw new Error(r.error || texts().errors.bridgeFailed);
    return r;
  };

  return {
    async check() {
      const r = await request({ type: 'hello' });
      if (typeof r.version === 'number' && r.version > VERSION) {
        throw new Error(texts().errors.bridgeNewer);
      }
    },
    async list() {
      return (await request({ type: 'list' })).speakers ?? [];
    },
    async play(speakerId, uri) {
      await request({ type: 'play', speakerId, uri });
    },
    async resume(speakerId) {
      await request({ type: 'resume', speakerId });
    },
    async pause(speakerId) {
      await request({ type: 'pause', speakerId });
    },
    onState(cb) {
      stateListener = cb;
    },
    close() {
      closed = true;
      if (current) failAll(current.pending, new Error(texts().errors.bridgeClosed));
      current = null;
      peer?.destroy();
    },
  };
}
