import type { Song } from '../game/engine';
import { getAccessToken } from './auth';

export class SpotifyError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The longest Spotify may ask us to wait before we give up and say so. */
const MAX_WAIT_SECONDS = 30;

/** Spotify asked us to slow down, for longer than is worth waiting for. */
export class RateLimitError extends SpotifyError {
  constructor(public retryAfterSeconds: number) {
    const minutes = Math.ceil(retryAfterSeconds / 60);
    super(
      retryAfterSeconds > MAX_WAIT_SECONDS
        ? `Spotify asks the game to wait ${minutes > 1 ? `about ${minutes} minutes` : 'a minute'} before asking again.`
        : 'Spotify is busy right now. Try again in a moment.',
      429,
    );
  }
}

/**
 * When Spotify says "too many requests", every request waits until then,
 * not just the one that was refused: firing the others anyway only makes
 * Spotify wait longer.
 */
let blockedUntil = 0;

async function waitForGate(): Promise<void> {
  const ms = blockedUntil - Date.now();
  if (ms <= 0) return;
  if (ms > MAX_WAIT_SECONDS * 1000) throw new RateLimitError(Math.ceil(ms / 1000));
  await wait(ms);
}

async function spotifyFetch(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
  await waitForGate();
  const token = await getAccessToken();
  if (!token) throw new SpotifyError('Not logged in to Spotify.', 401);
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });
  if (res.status === 429) {
    // Retry-After may be missing (or hidden from the browser): back off 5, 10, 20 seconds.
    const header = Number(res.headers.get('Retry-After'));
    const seconds = header > 0 ? header : 5 * 2 ** attempt;
    blockedUntil = Math.max(blockedUntil, Date.now() + seconds * 1000);
    if (seconds > MAX_WAIT_SECONDS || attempt >= 2) throw new RateLimitError(seconds);
    return spotifyFetch(path, init, attempt + 1);
  }
  if (!res.ok) {
    let message = `Spotify request failed (${res.status}).`;
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

export async function playOnDevice(deviceId: string, uri: string): Promise<void> {
  await spotifyFetch(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
    method: 'PUT',
    body: JSON.stringify({ uris: [uri] }),
  });
}
