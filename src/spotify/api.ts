import type { Song } from '../game/engine';
import { getAccessToken, getClientId } from './auth';
import { locale, msg } from '../i18n';

export class SpotifyError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How many times one request is refused before the game gives up on it. */
const MAX_ATTEMPTS = 6;
/** Pauses up to this long are waited out on the loading screen; longer ones are not. */
const MAX_AUTO_WAIT_SECONDS = 120;
/** Quotas belong to the Spotify app's developer account, so a block is kept per Client ID. */
const blockedKey = () => `mq.spotifyBlockedUntil:${getClientId()}`;

/**
 * Spotify won't answer for a long while: the game's request quota is used
 * up (Development Mode apps share one quota per developer account), or it
 * asked for a pause too long to sit through.
 */
export class RateLimitError extends SpotifyError {
  constructor(public until: number) {
    super(msg().errors.rateLimit(formatTime(until)), 429);
  }
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  return sameDay ? msg().errors.today(time) : `${d.toLocaleDateString(locale(), { weekday: 'long' })} ${time}`;
}

/**
 * When Spotify says "too many requests", every request waits until then,
 * not just the one that was refused: firing the others anyway only makes
 * Spotify wait longer. A long block is remembered across page loads, so a
 * reload doesn't knock on Spotify's door again. Screens can listen to show
 * a short wait.
 */
let blockedUntil = (() => {
  try {
    return Number(localStorage.getItem(blockedKey())) || 0;
  } catch {
    return 0;
  }
})();
const waitListeners = new Set<(until: number) => void>();

/** Calls `fn` with the time (ms since epoch) requests are paused until; returns an unsubscribe function. */
export function onSpotifyWait(fn: (until: number) => void): () => void {
  waitListeners.add(fn);
  if (blockedUntil > Date.now()) fn(blockedUntil);
  return () => void waitListeners.delete(fn);
}

/** When Spotify can be asked again, if it has asked the game to stop for a long while. */
export function spotifyBlockedUntil(): number | null {
  return blockedUntil - Date.now() > MAX_AUTO_WAIT_SECONDS * 1000 ? blockedUntil : null;
}

function block(until: number): void {
  if (until <= blockedUntil) return;
  blockedUntil = until;
  if (until - Date.now() > MAX_AUTO_WAIT_SECONDS * 1000) {
    try {
      localStorage.setItem(blockedKey(), String(until));
    } catch {
      /* ignore */
    }
  } else {
    for (const fn of waitListeners) fn(until);
  }
}

async function waitForGate(): Promise<void> {
  const long = spotifyBlockedUntil();
  if (long) throw new RateLimitError(long);
  while (blockedUntil > Date.now()) await wait(blockedUntil - Date.now());
}

/* ---------------- Log of the player commands, to see Spotify's own answers ---------------- */

/** One request to Spotify's player and its answer, as shown under "Spotify's replies". */
export interface SpotifyLogEntry {
  at: number;
  method: string;
  path: string;
  /** What was sent, if anything. */
  sent?: string;
  /** The HTTP status, or 0 when no answer came. */
  status: number;
  /** Spotify's answer as it came, cut short if long. */
  body: string;
}

const LOG_SIZE = 40;
const BODY_CHARS = 4000;
const log: SpotifyLogEntry[] = [];
const logListeners = new Set<() => void>();

/** The player requests so far, oldest first. Only /me/player… requests are kept; logging them costs no extra requests. */
export const spotifyLog = (): readonly SpotifyLogEntry[] => log;

/** Calls `fn` when a new entry is logged; returns an unsubscribe function. */
export function onSpotifyLog(fn: () => void): () => void {
  logListeners.add(fn);
  return () => void logListeners.delete(fn);
}

export function clearSpotifyLog(): void {
  log.length = 0;
  for (const fn of logListeners) fn();
}

function addToLog(entry: SpotifyLogEntry): void {
  log.push(entry);
  if (log.length > LOG_SIZE) log.splice(0, log.length - LOG_SIZE);
  for (const fn of logListeners) fn();
}

const logged = (path: string) => path.startsWith('/me/player');

async function record(path: string, init: RequestInit, res: Response | null): Promise<void> {
  if (!logged(path)) return;
  let body = '';
  try {
    body = res ? await res.clone().text() : '';
  } catch {
    /* unreadable */
  }
  addToLog({
    at: Date.now(),
    method: init.method ?? 'GET',
    path,
    sent: typeof init.body === 'string' ? init.body : undefined,
    status: res?.status ?? 0,
    body: body.length > BODY_CHARS ? `${body.slice(0, BODY_CHARS)}…` : body,
  });
}

async function spotifyFetch(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
  await waitForGate();
  const token = await getAccessToken();
  if (!token) throw new SpotifyError(msg().errors.notLoggedIn, 401);
  let res: Response;
  try {
    res = await fetch(`https://api.spotify.com/v1${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
    });
  } catch (e) {
    await record(path, init, null);
    throw e;
  }
  await record(path, init, res);
  if (res.status === 429) {
    let reason = '';
    try {
      reason = (await res.clone().json())?.error?.reason ?? '';
    } catch {
      /* no body */
    }
    // Retry-After may be missing (or hidden from the browser): then back
    // off 5, 10, 20… seconds. A used-up quota is not worth retrying soon.
    const header = Number(res.headers.get('Retry-After'));
    const fallback = reason === 'QUOTA_EXCEEDED' ? 3600 : 5 * 2 ** attempt;
    const seconds = header > 0 ? header : fallback;
    block(Date.now() + seconds * 1000);
    if (reason === 'QUOTA_EXCEEDED' || seconds > MAX_AUTO_WAIT_SECONDS || attempt + 1 >= MAX_ATTEMPTS) {
      throw new RateLimitError(Math.max(blockedUntil, Date.now() + seconds * 1000));
    }
    return spotifyFetch(path, init, attempt + 1);
  }
  if (!res.ok) {
    let message = msg().errors.requestFailed(res.status);
    try {
      const body = await res.json();
      if (body?.error?.message) message = `Spotify: ${body.error.message}`;
    } catch {
      /* empty body */
    }
    throw new SpotifyError(message, res.status);
  }
  return res;
}

/** GET a Web API path (starting with '/') and return the parsed JSON. */
export async function spotifyGet<T>(path: string): Promise<T> {
  return (await spotifyFetch(path)).json() as Promise<T>;
}

export interface SpotifyProfile {
  id: string;
  display_name: string;
  product: 'premium' | 'free' | 'open' | string;
}

export async function getProfile(): Promise<SpotifyProfile> {
  return (await spotifyFetch('/me')).json();
}

const trackCache = new Map<string, string | null>();

/** Finds the Spotify URI for a song, or null if nothing matches. */
export async function findTrackUri(song: Song): Promise<string | null> {
  if (song.spotifyId) return `spotify:track:${song.spotifyId}`;
  if (trackCache.has(song.id)) return trackCache.get(song.id)!;

  const firstArtist = song.artist.split(/\s*(?:&|,|feat\.|ft\.)\s*/i)[0];
  const queries = [`track:"${song.title}" artist:"${firstArtist}"`, `${song.title} ${firstArtist}`];
  let uri: string | null = null;
  for (const q of queries) {
    const params = new URLSearchParams({ q, type: 'track', limit: '5' });
    const body = await (await spotifyFetch(`/search?${params}`)).json();
    const items: { uri: string; name: string }[] = body?.tracks?.items ?? [];
    // Prefer the plain recording over live/karaoke/remix versions.
    const clean = items.find((t) => !/\b(live|karaoke|remix|instrumental|cover|acoustic)\b/i.test(t.name));
    uri = (clean ?? items[0])?.uri ?? null;
    if (uri) break;
  }
  trackCache.set(song.id, uri);
  return uri;
}

/** `?device_id=…`, or nothing for the device Spotify is playing on right now. */
const onDevice = (deviceId: string) => (deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '');

/** Starts `uri` on the device, `positionMs` into the song. */
export async function playOnDevice(deviceId: string, uri: string, positionMs = 0): Promise<void> {
  await spotifyFetch(`/me/player/play${onDevice(deviceId)}`, {
    method: 'PUT',
    body: JSON.stringify({ uris: [uri], ...(positionMs > 0 ? { position_ms: Math.round(positionMs) } : {}) }),
  });
}

/* ---------------- Playing on Spotify Connect devices ---------------- */

export interface SpotifyDevice {
  id: string | null;
  name: string;
  /** "Computer", "Smartphone", "Speaker", "TV", "CastAudio", "AVR"… */
  type: string;
  is_active: boolean;
  /** True: Spotify accepts no commands from apps for this device (often a Sonos). */
  is_restricted: boolean;
  /** In a private session Spotify doesn't say what plays on it. */
  is_private_session?: boolean;
}

/** The devices the account's Spotify apps can play on right now (one request). */
export async function getDevices(): Promise<SpotifyDevice[]> {
  const body = await (await spotifyFetch('/me/player/devices')).json();
  return body?.devices ?? [];
}

export interface PlaybackState {
  device: SpotifyDevice | null;
  is_playing: boolean;
  item: { uri: string; linked_from?: { uri: string } | null } | null;
}

/** What plays where right now, or null when Spotify plays nowhere (one request). */
export async function getPlaybackState(): Promise<PlaybackState | null> {
  const res = await spotifyFetch('/me/player');
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? (JSON.parse(text) as PlaybackState) : null;
}

/** Moves playback to the device and makes it the active one. `play: false` keeps it paused if it was. */
export async function transferPlayback(deviceId: string, play: boolean): Promise<void> {
  await spotifyFetch('/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [deviceId], play }) });
}

export async function pauseDevice(deviceId: string): Promise<void> {
  await spotifyFetch(`/me/player/pause${onDevice(deviceId)}`, { method: 'PUT' });
}

export async function resumeDevice(deviceId: string): Promise<void> {
  await spotifyFetch(`/me/player/play${onDevice(deviceId)}`, { method: 'PUT' });
}
