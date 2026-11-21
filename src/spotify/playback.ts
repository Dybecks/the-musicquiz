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
import { findTrackUri, getPlaybackState, pauseDevice, playOnDevice, RateLimitError, resumeDevice, SpotifyError, transferPlayback } from './api';
import { getAccessToken } from './auth';
import { msg } from '../i18n';

export type PlaybackKind = 'premium' | 'embed' | 'none';

export interface Playback {
  kind: PlaybackKind;
  /** Look up and load the song. Rejects with a readable message if it can't be played. */
  prepare(song: Song): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  onStateChange(cb: (playing: boolean) => void): void;
  destroy(): void;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** The song isn't on Spotify: skipping it helps. */
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
  /** null when this player isn't the one Spotify plays on. */
  getCurrentState(): Promise<unknown | null>;
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
  // The SDK drops its device when the connection is lost (a sleeping computer,
  // a tab left in the background): connect again so Spotify lists it again.
  player.addListener('not_ready', () => void player.connect());
  /**
   * The first song is started here, in the browser. After that every command
   * goes to wherever Spotify plays now (no device id), so a speaker or phone
   * picked in the Spotify app keeps the music, even one Spotify hides from
   * apps (often a Sonos). Only when nothing is active any more does the song
   * come back here.
   *
   * Spotify's report of where it plays isn't trusted for this: after a move it
   * can name no device, or still name this one, for a while.
   */
  let startedHere = false;
  /** Where the next command goes: '' is the device Spotify plays on now. */
  const target = () => (startedHere ? '' : deviceId);

  /** Spotify won't let the game control the device the music is on now. */
  const refused = (e: unknown) => e instanceof SpotifyError && !(e instanceof RateLimitError) && e.status === 403;
  /** No device is active any more. */
  const noDevice = (e: unknown) => e instanceof SpotifyError && !(e instanceof RateLimitError) && e.status === 404;
  const cantControl = () => new Error(msg().errors.connectCantControl);
  const playingHere = async () => {
    const st = (await player.getCurrentState().catch(() => null)) as { paused?: boolean } | null;
    return !!st && !st.paused;
  };

  player.addListener('player_state_changed', (state) => {
    if (state && !state.paused) return listener(true);
    // Paused or gone here: paused, or moved to another device in the app.
    void getPlaybackState()
      .then((s) => {
        if (!s) return; // Spotify says nothing (a hidden device): leave the button as it is.
        listener(s.device?.id !== deviceId && s.is_playing);
      })
      .catch(() => {});
  });

  /**
   * Plays the song in this browser. Spotify answers "Device not found" while
   * it hasn't registered the player yet (just after it started, or after the
   * connection dropped): then connect again, make this player the active one
   * and try once more.
   */
  const playHere = async (song: string) => {
    try {
      await playOnDevice(deviceId, song);
    } catch (e) {
      if (!noDevice(e)) throw e;
      await player.connect().catch(() => false);
      await transferPlayback(deviceId, false).catch((err) => {
        if (err instanceof RateLimitError) throw err;
      });
      await wait(1000);
      await playOnDevice(deviceId, song);
    }
  };

  /** Starts the song: where Spotify plays now, or here if nothing is active. */
  const start = async (song: string) => {
    await player.activateElement().catch(() => {});
    if (!startedHere) await playHere(song);
    else {
      try {
        await playOnDevice('', song);
      } catch (e) {
        if (refused(e)) throw cantControl();
        if (!noDevice(e)) throw e;
        await playHere(song);
      }
    }
    startedHere = true;
  };

  const pauseNow = async () => {
    if (await playingHere()) return player.pause();
    try {
      await pauseDevice(target());
    } catch (e) {
      // Spotify answers 403 or 404 to pausing what already stopped; only a song still playing means it failed.
      const s = await getPlaybackState().catch(() => null);
      if (s?.is_playing) throw refused(e) ? cantControl() : e;
      if (!s && refused(e)) throw cantControl();
    }
  };

  return {
    kind: 'premium',
    async prepare(song) {
      await pauseNow().catch(() => {});
      uri = await uriFor(song);
      started = false;
    },
    async play() {
      if (!uri) return;
      if (!started) {
        await start(uri);
        started = true;
      } else {
        await player.activateElement().catch(() => {});
        try {
          await resumeDevice(target());
        } catch (e) {
          if (refused(e)) throw cantControl();
          if (!noDevice(e)) throw e;
          // Nothing is active any more: carry on here, where the browser left off if it can.
          if (await player.getCurrentState().catch(() => null)) await player.resume();
          else await playHere(uri);
        }
      }
      listener(true);
    },
    async pause() {
      await pauseNow();
      listener(false);
    },
    async stop() {
      await pauseNow().catch(() => {});
      listener(false);
      uri = null;
      started = false;
    },
    onStateChange(cb) {
      listener = cb;
    },
    destroy() {
      if (startedHere) void pauseNow().catch(() => {});
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
