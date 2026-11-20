import type { DataConnection, Peer } from 'peerjs';
import { makePeer } from '../multiplayer/connection';

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

type Reply = { type: 'reply'; id: number; ok: boolean; error?: string; speakers?: SonosSpeaker[] };
type BridgeMessage = Reply | { type: 'state'; speakerId: string; playing: boolean };

export interface BridgeLink {
  list(): Promise<SonosSpeaker[]>;
  play(speakerId: string, uri: string): Promise<void>;
  resume(speakerId: string): Promise<void>;
  pause(speakerId: string): Promise<void>;
  onState(cb: (speakerId: string, playing: boolean) => void): void;
  close(): void;
}

const TIMEOUT_MS = 15000;
const NOT_FOUND = 'No Sonos bridge answers to that code. Is the bridge running on a computer on this Wi-Fi? It shows the code when it starts.';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Connect to the bridge with `code`. Each request waits for the connection,
 * and a dropped connection is made again on the next request.
 */
export function connectBridge(code: string): BridgeLink {
  let peer: Peer | null = null;
  let conn: Promise<DataConnection> | null = null;
  let closed = false;
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();
  let stateListener: (speakerId: string, playing: boolean) => void = () => {};

  const failAll = (e: Error) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };

  const open = (): Promise<DataConnection> =>
    new Promise((resolve, reject) => {
      void (async () => {
        try {
          if (!peer || peer.destroyed) {
            peer = await makePeer();
            await new Promise<void>((ok, fail) => {
              peer!.once('open', () => ok());
              peer!.once('error', (err) => fail(new Error(`Can’t reach the connection server (${err.type}).`)));
            });
          }
          const p = peer;
          const c = p.connect(bridgePeerId(code), { reliable: true, serialization: 'json' });
          const timer = setTimeout(() => reject(new Error(NOT_FOUND)), TIMEOUT_MS);
          const onPeerError = (err: { type: string }) => {
            if (err.type === 'peer-unavailable') {
              clearTimeout(timer);
              reject(new Error(NOT_FOUND));
            }
          };
          p.on('error', onPeerError);
          c.on('open', () => {
            clearTimeout(timer);
            p.off('error', onPeerError);
            resolve(c);
          });
          c.on('data', (data) => {
            const msg = data as BridgeMessage;
            if (msg?.type === 'reply') {
              const waiting = pending.get(msg.id);
              pending.delete(msg.id);
              waiting?.resolve(msg);
            } else if (msg?.type === 'state') stateListener(msg.speakerId, msg.playing);
          });
          const lost = () => {
            conn = null;
            failAll(new Error('Lost the connection to the Sonos bridge.'));
          };
          c.on('close', lost);
          c.on('error', lost);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(message(e)));
        }
      })();
    });

  const request = async (msg: Record<string, unknown>): Promise<Reply> => {
    if (closed) throw new Error('The Sonos bridge connection is closed.');
    conn ??= open().catch((e) => {
      conn = null;
      throw e;
    });
    const c = await conn;
    const id = nextId++;
    const reply = new Promise<Reply>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error('The Sonos bridge didn’t answer in time.'));
      }, TIMEOUT_MS);
    });
    c.send({ ...msg, id });
    const r = await reply;
    if (!r.ok) throw new Error(r.error || 'The Sonos bridge couldn’t do that.');
    return r;
  };

  return {
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
      failAll(new Error('The Sonos bridge connection is closed.'));
      peer?.destroy();
    },
  };
}
