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

async function spotifyFetch(path: string, init: RequestInit = {}, retries = 2): Promise<Response> {
  const token = await getAccessToken();
  if (!token) throw new SpotifyError('Not logged in to Spotify.', 401);
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });
  // Rate limited: wait as long as Spotify asks (capped) and try again.
  if (res.status === 429 && retries > 0) {
    const seconds = Math.min(Number(res.headers.get('Retry-After')) || 2, 30);
    await wait(seconds * 1000);
    return spotifyFetch(path, init, retries - 1);
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
