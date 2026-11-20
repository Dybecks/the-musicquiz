#!/usr/bin/env node
/**
 * The Music Quiz – Sonos bridge.
 *
 * Runs on a computer on the same network as the Sonos speakers. The game
 * connects to it over WebRTC (PeerJS, like the phones do) with a speaker
 * code, lists the speakers and plays each mystery song on the chosen one.
 *
 *   node index.js                 find speakers automatically
 *   node index.js --speaker IP    if automatic search finds nothing
 *   node index.js --code ABCDEF   use (and remember) this speaker code
 */
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from 'node-datachannel/polyfill';
import WebSocket from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as sonos from './sonos.js';

// PeerJS expects the browser's WebRTC and WebSocket classes. The `ws` one
// also reports a failed connection as closed (Node's own doesn't), and
// Node 20 has none.
class QuietWebSocket extends WebSocket {
  constructor(...args) {
    super(...args);
    // PeerJS only listens for "close"; an unheard "error" would end the program.
    this.on('error', () => {});
  }
}
Object.assign(globalThis, { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, WebSocket: QuietWebSocket });
const { Peer } = (await import('peerjs')).default;

export const VERSION = 1;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CONFIG = path.join(os.homedir(), '.the-musicquiz-bridge.json');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

function saveCode(config, code) {
  try {
    fs.writeFileSync(CONFIG, JSON.stringify({ ...config, code }, null, 2));
  } catch {
    /* it just won't be remembered */
  }
}

function speakerCode() {
  const config = loadConfig();
  const given = arg('code');
  if (given !== undefined) {
    const code = given.toUpperCase();
    if (!/^[A-Z]{6}$/.test(code)) {
      console.error('The code must be six letters, like --code KQWMTR.');
      process.exit(1);
    }
    saveCode(config, code);
    return code;
  }
  if (/^[A-Z]{6}$/.test(config.code ?? '')) return config.code;
  const code = Array.from({ length: 6 }, () => CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)]).join('');
  saveCode(config, code);
  return code;
}

/** Must match bridgePeerId() in the game (src/sonos/bridge.ts). */
const peerId = (code) => `the-musicquiz-speaker-${code.toLowerCase()}`;

function peerOptions() {
  const env = process.env;
  if (!env.MQ_PEER_HOST) return {};
  return {
    host: env.MQ_PEER_HOST,
    port: env.MQ_PEER_PORT ? Number(env.MQ_PEER_PORT) : undefined,
    path: env.MQ_PEER_PATH || '/',
    secure: env.MQ_PEER_SECURE !== 'false',
  };
}

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

/* ---------------- Speakers ---------------- */

let cache = { at: 0, groups: [] };

async function findGroups(fresh = false) {
  if (!fresh && Date.now() - cache.at < 30_000 && cache.groups.length) return cache.groups;
  const given = arg('speaker');
  const hosts = given ? [given.includes(':') ? given : `${given}:1400`] : await sonos.discover();
  let lastError;
  for (const host of hosts) {
    try {
      const groups = await sonos.groups(host);
      cache = { at: Date.now(), groups };
      return groups;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(
    lastError
      ? lastError.message
      : 'No Sonos speakers found on this network. Is this computer on the same Wi-Fi? If so, start the bridge with --speaker <IP of a Sonos speaker> (shown in the Sonos app under Settings → System → About My System).',
  );
}

async function groupById(id) {
  if (typeof id !== 'string' || !id) return null;
  return (await findGroups()).find((g) => g.id === id) ?? (await findGroups(true)).find((g) => g.id === id) ?? null;
}

/* ---------------- One game connected ---------------- */

function serve(conn) {
  log('A game connected.');
  let active = null; // the group this game plays on
  let lastPlaying = null;
  let poll = null;
  let polling = false;
  // Requests run one at a time, so a double tap can't interleave two plays.
  let queue = Promise.resolve();

  const send = (msg) => conn.open && conn.send(msg);

  const watch = () => {
    clearInterval(poll);
    poll = setInterval(async () => {
      if (!active || polling) return;
      polling = true;
      try {
        const state = await sonos.transportState(active);
        if (state === 'TRANSITIONING') return;
        const playing = state === 'PLAYING';
        if (playing !== lastPlaying) {
          lastPlaying = playing;
          send({ type: 'state', speakerId: active.id, playing });
        }
      } catch {
        /* the next poll may work */
      } finally {
        polling = false;
      }
    }, 1500);
  };

  const handle = async (msg) => {
    switch (msg.type) {
      case 'hello':
        return { version: VERSION };
      case 'list':
        return { speakers: (await findGroups(true)).map(({ id, name }) => ({ id, name })) };
      case 'play':
      case 'resume':
      case 'pause': {
        const group = await groupById(msg.speakerId);
        if (!group) throw new Error('That speaker isn’t on the network any more. Pick it again.');
        if (msg.type === 'pause') {
          await sonos.pause(group);
        } else {
          if (msg.type === 'play') sonos.spotifyTrack(msg.uri, sonos.SPOTIFY_REGIONS[0]); // check it before touching the speaker
          if (active && active.id !== group.id) await sonos.pause(active).catch(() => {});
          active = group;
          if (msg.type === 'play') {
            log(`Playing a song on ${group.name}.`);
            await sonos.playSpotify(group, msg.uri);
          } else await sonos.resume(group);
        }
        lastPlaying = msg.type !== 'pause';
        send({ type: 'state', speakerId: group.id, playing: lastPlaying });
        watch();
        return {};
      }
      default:
        throw new Error(`Unknown request: ${msg.type}`);
    }
  };

  conn.on('data', (data) => {
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    queue = queue.then(async () => {
      try {
        send({ type: 'reply', id: data.id, ok: true, ...(await handle(data)) });
      } catch (e) {
        log(`  ${e.message}`);
        send({ type: 'reply', id: data.id, ok: false, error: e.message });
      }
    });
  });
  const gone = () => {
    clearInterval(poll);
    poll = null;
  };
  conn.on('close', () => {
    gone();
    log('A game disconnected.');
  });
  conn.on('error', gone);
}

/* ---------------- The connection server ---------------- */

const code = speakerCode();
let peer = null;
let everOpen = false;
let takenTries = 0;
let startedAt = 0;

function start() {
  peer?.destroy();
  startedAt = Date.now();
  const p = new Peer(peerId(code), peerOptions());
  peer = p;
  p.on('open', () => {
    takenTries = 0;
    if (!everOpen) log(`Ready. In the game, tap 🔊 and enter the speaker code:  ${code}`);
    everOpen = true;
  });
  p.on('connection', serve);
  p.on('error', (err) => {
    if (p !== peer) return;
    if (err.type === 'unavailable-id') {
      // Right after a network drop the server may still hold our old
      // connection for a minute; only a first start gives up.
      p.destroy();
      if (!everOpen && ++takenTries > 5) {
        console.error(`The code ${code} is in use by another bridge. Stop that one, or start this one with --code and six other letters.`);
        process.exit(1);
      }
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      log('Can’t reach the connection server. Retrying…');
    } else if (err.type !== 'peer-unavailable') {
      log(`Connection: ${err.message}`);
    }
  });
}

// Keep the link to the connection server alive. Games already connected keep
// working without it; reconnecting keeps their connections.
let closedSince = 0;
setInterval(() => {
  if (!peer || peer.destroyed) return start();
  if (peer.open) {
    if (closedSince) log('Connected to the connection server again.');
    closedSince = 0;
    return;
  }
  closedSince ||= Date.now();
  if (peer.disconnected && everOpen) {
    try {
      return peer.reconnect();
    } catch {
      /* start over below */
    }
  }
  // Never got through, or stuck connecting: start over.
  if (Date.now() - Math.max(startedAt, everOpen ? closedSince : 0) > (everOpen ? 120_000 : 20_000)) start();
}, 5000);

log('The Music Quiz – Sonos bridge');
findGroups(true)
  .then((groups) => log(`Found: ${groups.map((g) => g.name).join(', ') || 'no speakers'}`))
  .catch((e) => log(e.message));
start();
