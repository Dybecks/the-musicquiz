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
 *   node index.js --code ABCDEF   use this speaker code
 */
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from 'node-datachannel/polyfill';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as sonos from './sonos.js';

// PeerJS expects the browser's WebRTC classes.
Object.assign(globalThis, { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate });
const { Peer } = (await import('peerjs')).default;

const VERSION = 1;
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

function speakerCode() {
  const given = arg('code')?.toUpperCase();
  if (given && /^[A-Z]{6}$/.test(given)) return given;
  const config = loadConfig();
  if (/^[A-Z]{6}$/.test(config.code ?? '')) return config.code;
  const code = Array.from({ length: 6 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join('');
  try {
    fs.writeFileSync(CONFIG, JSON.stringify({ ...config, code }, null, 2));
  } catch {
    /* it just won't be remembered */
  }
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
  return (await findGroups()).find((g) => g.id === id) ?? (await findGroups(true)).find((g) => g.id === id) ?? null;
}

/* ---------------- One game connected ---------------- */

function serve(conn) {
  log(`A game connected.`);
  let active = null; // the group this game plays on
  let lastPlaying = null;
  let poll = null;

  const send = (msg) => conn.open && conn.send(msg);

  const watch = () => {
    clearInterval(poll);
    poll = setInterval(async () => {
      if (!active) return;
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
      }
    }, 1500);
  };

  const handle = async (msg) => {
    switch (msg.type) {
      case 'hello':
        return { version: VERSION, name: os.hostname() };
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

  conn.on('data', async (data) => {
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    try {
      send({ type: 'reply', id: data.id, ok: true, ...(await handle(data)) });
    } catch (e) {
      log(`  ${e.message}`);
      send({ type: 'reply', id: data.id, ok: false, error: e.message });
    }
  });
  conn.on('close', () => {
    clearInterval(poll);
    log('A game disconnected.');
  });
  conn.on('error', () => clearInterval(poll));
}

/* ---------------- The connection server ---------------- */

const code = speakerCode();
let tries = 0;

function start() {
  const peer = new Peer(peerId(code), peerOptions());
  peer.on('open', () => {
    tries = 0;
    log(`Ready. In the game, tap 🔊 and enter the speaker code:  ${code}`);
  });
  peer.on('connection', serve);
  peer.on('disconnected', () => {
    if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 3000);
  });
  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      peer.destroy();
      if (++tries > 5) {
        console.error(`The code ${code} is in use by another bridge. Stop that one, or start this one with --code and another six letters.`);
        process.exit(1);
      }
      setTimeout(start, 5000);
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      log('Lost the connection server. Retrying…');
      peer.destroy();
      setTimeout(start, 5000);
    } else {
      log(`Connection: ${err.message}`);
    }
  });
}

log('The Music Quiz – Sonos bridge');
findGroups(true)
  .then((groups) => log(`Found: ${groups.map((g) => g.name).join(', ') || 'no speakers'}`))
  .catch((e) => log(e.message));
start();
