import { getDevices, pauseDevice, playOnDevice, resumeDevice, SpotifyError, transferPlayback, type SpotifyDevice } from './api';
import { uriFor, type Playback } from './playback';

/**
 * Steers the Spotify app instead of playing here: each song is started on
 * the device the Spotify app plays on right now (the phone itself, or a
 * speaker picked in the app, like a Sonos or a TV). Needs Spotify Premium.
 *
 * Starting a song costs two requests (find the device, play), three when
 * the app is open but idle (it is woken first), and each pause or resume
 * one; nothing is polled, so pausing in the Spotify app itself isn't seen
 * here. Commands that only fail because the app already is where it was
 * asked to be (paused, playing) count as done.
 */

export const NOTHING_ACTIVE =
  'Spotify can’t see the Spotify app right now. Open the Spotify app (a phone closes it in the background after a while when nothing plays), start any song there, then press Play here again.';

const scopeMissing = 'The Spotify login is missing permission to steer the app. End the game, log out of Spotify in setup and log in again.';

const restricted = (d: SpotifyDevice) =>
  `Spotify won’t let other apps control “${d.name}”. If it’s a Sonos, pick it in the Spotify app’s device list (the speaker icon), not in the Sonos app, start a song there and try again. Otherwise choose another speaker under 🔊.`;

const premiumNeeded = 'Steering the Spotify app needs Spotify Premium.';

/** How long to wait before asking a just-woken app again. */
export const RETRY_MS = 1000;

/** The game's own in-browser player. Spotify keeps listing it for a while after it's gone. */
const OWN_PLAYER = 'The Music Quiz';

/**
 * The device to play on: the one the Spotify app is using now, or else one
 * that is open but idle (the phone's app often isn't "active" until it plays).
 */
export function chooseDevice(all: SpotifyDevice[]): SpotifyDevice {
  const devices = all.filter((d) => d.name !== OWN_PLAYER);
  const active = devices.find((d) => d.is_active);
  if (active) {
    if (active.is_restricted || !active.id) throw new Error(restricted(active));
    return active;
  }
  const usable = devices.filter((d) => d.id && !d.is_restricted);
  const pick = usable.find((d) => d.type === 'Smartphone') ?? usable[0];
  if (pick) return pick;
  const locked = devices.find((d) => d.is_restricted);
  throw new Error(locked ? restricted(locked) : NOTHING_ACTIVE);
}

async function activeDevice(): Promise<SpotifyDevice> {
  return chooseDevice(await getDevices());
}

const is = (e: unknown, status: number) => e instanceof SpotifyError && e.status === status;
/** Spotify refused because the app already is paused, or already playing. */
const alreadyThere = (e: unknown) => is(e, 403) && /restriction|already/i.test((e as Error).message);

function explain(e: unknown, device: SpotifyDevice | null): never {
  if (e instanceof SpotifyError) {
    // Spotify's own words help when the guess below is wrong.
    const why = ` (${e.message.replace(/^Spotify: /, '')})`;
    if (/scope/i.test(e.message) || e.status === 401) throw new Error(scopeMissing + why);
    if (e.status === 404) throw new Error(NOTHING_ACTIVE + why);
    if (e.status === 403) {
      if (/premium/i.test(e.message) || !device) throw new Error(premiumNeeded + why);
      throw new Error(restricted(device) + why);
    }
  }
  throw e;
}

export function createSpotifyAppPlayback(): Playback {
  let listener: (playing: boolean) => void = () => {};
  let uri: string | null = null;
  let device: SpotifyDevice | null = null;
  let started = false;
  let playing = false;
  const set = (p: boolean) => {
    playing = p;
    listener(p);
  };

  return {
    kind: 'spotify-app',
    async prepare(song) {
      if (playing && device?.id) await pauseDevice(device.id).catch(() => {});
      set(false);
      started = false;
      uri = await uriFor(song);
    },
    async play() {
      if (!uri) return;
      const song = uri;
      /** Starts the song from the top on the device the app uses now. */
      const start = async () => {
        // The device may have changed since the last song (picked in the app).
        const d = await activeDevice();
        device = d;
        const id = d.id!;
        // An open but idle app often ignores "play" until it is woken.
        if (!d.is_active) await transferPlayback(id);
        try {
          await playOnDevice(id, song);
        } catch (e) {
          // Waking can take a moment: one more go.
          if (![404, 502, 503].some((s) => is(e, s))) throw e;
          await new Promise((r) => setTimeout(r, RETRY_MS));
          await playOnDevice(id, song);
        }
        started = true;
      };
      try {
        if (!started) await start();
        else {
          try {
            await resumeDevice(device!.id!);
          } catch (e) {
            if (alreadyThere(e)) {
              /* already playing */
            } else if (is(e, 404)) await start(); // The app went away meanwhile.
            else throw e;
          }
        }
      } catch (e) {
        explain(e, device);
      }
      set(true);
    },
    async pause() {
      try {
        await pauseDevice(device?.id ?? '');
      } catch (e) {
        // Already paused, or the app is gone (and with it the music): paused either way.
        if (!alreadyThere(e) && !is(e, 404)) explain(e, device);
      }
      set(false);
    },
    async stop() {
      if (playing && device?.id) await pauseDevice(device.id).catch(() => {});
      set(false);
      uri = null;
      started = false;
    },
    onStateChange(cb) {
      listener = cb;
    },
    destroy() {
      if (playing && device?.id) void pauseDevice(device.id).catch(() => {});
      listener = () => {};
    },
  };
}
