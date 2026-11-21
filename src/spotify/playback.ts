/**
 * Two ways to play a song without showing its title:
 *
 *  - "premium": the Spotify Web Playback SDK turns this browser tab into a
 *    Spotify Connect device and plays the full track. Needs Spotify Premium.
 *  - "embed": the Spotify Embed (iFrame API) player, kept hidden behind a
 *    cover. Needs no login for songs with a known Spotify id; it plays the
 *    full track if the browser is signed in to Spotify, otherwise a preview.
 *
 * Songs without a known id are found via search, which needs the login.
 */
import type { Song } from '../game/engine';
import { findTrackUri, getPlaybackState, pauseDevice, playOnDevice, RateLimitError, resumeDevice, type PlaybackState } from './api';
import { getAccessToken } from './auth';
import { msg } from '../i18n';

export type PlaybackKind = 'premium' | 'embed' | 'none';

export interface Playback {
  /**
   * Not in this browser: 'sonos' plays on a Sonos through the bridge
   * (src/sonos/playback.ts), 'spotify-connect' on a Spotify Connect device
   * such as a speaker, TV or the Spotify app on a computer or phone
   * (src/spotify/remote.ts).
   */
  kind: PlaybackKind | 'sonos' | 'spotify-connect';
  /** Look up and load the song. Rejects with a readable message if it can't be played. */
  prepare(song: Song): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  onStateChange(cb: (playing: boolean) => void): void;
  destroy(): void;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(msg().errors.couldNotLoad(src)));
    document.body.appendChild(s);
  });
}

/** The song isn't on Spotify: skipping it helps, another speaker doesn't. */
export class SongNotFoundError extends Error {
  constructor() {
    super(msg().errors.songNotFound);
  }
}

export async function uriFor(song: Song): Promise<string> {
  const uri = await findTrackUri(song);
  if (!uri) throw new SongNotFoundError();
  return uri;
}

/* ---------------- Web Playback SDK (Premium) ---------------- */

interface SdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  activateElement(): Promise<void>;
  addListener(event: string, cb: (arg: any) => void): void;
}

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: { Player: new (opts: { name: string; getOAuthToken: (cb: (t: string) => void) => void; volume?: number }) => SdkPlayer };
    onSpotifyIframeApiReady?: (api: IFrameApi) => void;
  }
}

let sdkReady: Promise<void> | null = null;
function loadSdk(): Promise<void> {
  sdkReady ??= new Promise<void>((resolve, reject) => {
    if (window.Spotify) return resolve();
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    loadScript('https://sdk.scdn.co/spotify-player.js').catch(reject);
  });
  return sdkReady;
}

export async function createPremiumPlayback(): Promise<Playback> {
  await loadSdk();
  const player = new window.Spotify!.Player({
    name: 'The Music Quiz',
    volume: 0.8,
    getOAuthToken: (cb) => {
      void getAccessToken().then((t) => t && cb(t));
    },
  });
  let listener: (playing: boolean) => void = () => {};
  let uri: string | null = null;
  let started = false;

  const deviceId = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg().errors.playerTimeout)), 15000);
    player.addListener('ready', ({ device_id }) => {
      clearTimeout(timer);
      resolve(device_id);
    });
    player.addListener('initialization_error', ({ message }) => reject(new Error(message)));
    player.addListener('authentication_error', ({ message }) => reject(new Error(message)));
    player.addListener('account_error', () => reject(new Error(msg().errors.premiumNeeded)));
    void player.connect();
  });
  /**
   * The Spotify Connect device the song was moved to in the Spotify app (a
   * speaker, the phone…), or null while it plays here. Once a song of ours is
   * seen playing elsewhere, the game keeps sending pause, resume and the next
   * songs there instead of pulling them back to the browser, until the
   * player picks the browser again in the app.
   */
  let elsewhere: string | null = null;
  /** The last song started, to tell our song on another device from something else playing there. */
  let lastUri: string | null = null;

  const ours = (s: PlaybackState) => !!s.item && (s.item.uri === lastUri || s.item.linked_from?.uri === lastUri);

  /** Asks Spotify where the music plays and updates `elsewhere` (one request). */
  const locate = async (): Promise<PlaybackState | null> => {
    const s = await getPlaybackState().catch((e) => {
      if (e instanceof RateLimitError) throw e;
      return undefined;
    });
    // Couldn't ask: keep what we knew.
    if (s === undefined) return null;
    if (s?.device?.id === deviceId) elsewhere = null;
    else if (s?.device?.id && lastUri && ours(s)) elsewhere = s.device.id;
    return s;
  };

  player.addListener('player_state_changed', (state) => {
    if (state) {
      if (!elsewhere) listener(!state.paused);
      return;
    }
    // The browser lost the song, often because it was moved to another device in the app.
    void locate()
      .then((s) => listener(!!elsewhere && !!s?.is_playing))
      .catch(() => listener(false));
  });

  const pauseAll = async () => {
    if (elsewhere) await pauseDevice(elsewhere).catch(() => {});
    await player.pause().catch(() => {});
  };

  return {
    kind: 'premium',
    async prepare(song) {
      await locate().catch(() => null);
      await pauseAll();
      uri = await uriFor(song);
      started = false;
    },
    async play() {
      if (!uri) return;
      await locate();
      if (!elsewhere) await player.activateElement().catch(() => {});
      if (!started) {
        lastUri = uri;
        if (elsewhere) {
          try {
            await playOnDevice(elsewhere, uri);
          } catch (e) {
            if (e instanceof RateLimitError) throw e;
            // The other device is gone: play here again.
            elsewhere = null;
            await player.activateElement().catch(() => {});
            await playOnDevice(deviceId, uri);
          }
        } else await playOnDevice(deviceId, uri);
        started = true;
      } else if (elsewhere) {
        await resumeDevice(elsewhere);
      } else {
        await player.resume();
      }
      if (elsewhere) listener(true);
    },
    async pause() {
      await locate();
      if (elsewhere) {
        await pauseDevice(elsewhere).catch(async (e) => {
          // Spotify answers 403 to pausing what already stopped; only a song still playing means it failed.
          const s = await getPlaybackState().catch(() => null);
          if (s?.is_playing && s.device?.id === elsewhere) throw e;
        });
        listener(false);
      } else await player.pause();
    },
    async stop() {
      await pauseAll();
      if (elsewhere) listener(false);
      uri = null;
      started = false;
    },
    onStateChange(cb) {
      listener = cb;
    },
    destroy() {
      if (elsewhere) void pauseDevice(elsewhere).catch(() => {});
      player.disconnect();
    },
  };
}

/* ---------------- Embed (iFrame API) ---------------- */

interface EmbedController {
  loadUri(uri: string): void;
  play(): void;
  resume(): void;
  pause(): void;
  togglePlay(): void;
  addListener(event: string, cb: (e: any) => void): void;
  destroy(): void;
}
interface IFrameApi {
  createController(el: HTMLElement, opts: { uri: string; width?: string | number; height?: string | number }, cb: (c: EmbedController) => void): void;
}

let iframeApi: Promise<IFrameApi> | null = null;
function loadIframeApi(): Promise<IFrameApi> {
  iframeApi ??= new Promise<IFrameApi>((resolve, reject) => {
    window.onSpotifyIframeApiReady = (api) => resolve(api);
    loadScript('https://open.spotify.com/embed/iframe-api/v1').catch(reject);
  });
  return iframeApi;
}

export async function createEmbedPlayback(host: HTMLElement): Promise<Playback> {
  const api = await loadIframeApi();
  const mount = document.createElement('div');
  host.replaceChildren(mount);
  let controller: EmbedController | null = null;
  let listener: (playing: boolean) => void = () => {};
  let ready: Promise<void> = Promise.resolve();
  let loadedUri: string | null = null;
  let started = false;

  const ensureController = (uri: string) =>
    new Promise<void>((resolve) => {
      api.createController(mount, { uri, width: '100%', height: 152 }, (c) => {
        controller = c;
        // A 30-second preview may end without reporting a pause: treat the end as stopped.
        c.addListener('playback_update', (e) => {
          const { isPaused, position, duration } = e.data;
          listener(!isPaused && !(duration > 0 && position >= duration));
        });
        c.addListener('ready', () => resolve());
      });
    });

  return {
    kind: 'embed',
    async prepare(song) {
      controller?.pause();
      const uri = await uriFor(song);
      started = false;
      if (!controller) ready = ensureController(uri);
      else if (uri !== loadedUri) {
        ready = new Promise((resolve) => {
          controller!.addListener('ready', () => resolve());
          controller!.loadUri(uri);
          setTimeout(resolve, 3000);
        });
      }
      loadedUri = uri;
      await ready;
    },
    async play() {
      await ready;
      if (!started) {
        controller?.play();
        started = true;
      } else controller?.resume();
    },
    async pause() {
      controller?.pause();
    },
    async stop() {
      controller?.pause();
      started = false;
    },
    onStateChange(cb) {
      listener = cb;
    },
    destroy() {
      controller?.destroy();
      host.replaceChildren();
    },
  };
}

/* ---------------- No audio (rules demo / play the music yourself) ---------------- */

export function createSilentPlayback(): Playback {
  return {
    kind: 'none',
    async prepare() {},
    async play() {},
    async pause() {},
    async stop() {},
    onStateChange() {},
    destroy() {},
  };
}
