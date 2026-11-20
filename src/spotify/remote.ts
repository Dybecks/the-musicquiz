import { getDevices, pauseDevice, playOnDevice, resumeDevice, SpotifyError, type SpotifyDevice } from './api';
import { uriFor, type Playback } from './playback';
import { msg } from '../i18n';

/**
 * Steers the Spotify app instead of playing here: each song is started on
 * the device the Spotify app plays on right now (the phone itself, or a
 * speaker picked in the app, like a Sonos or a TV). Needs Spotify Premium.
 *
 * Starting a song costs two requests (find the device, play) and each pause
 * or resume one; nothing is polled, so pausing in the Spotify app itself
 * isn't seen here.
 */

const nothingActive = () => msg().errors.appNotOpen;
const restricted = (d: SpotifyDevice) => msg().errors.appRestricted(d.name);
const premiumNeeded = () => msg().errors.appPremium;

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
  throw new Error(locked ? restricted(locked) : nothingActive());
}

async function activeDevice(): Promise<SpotifyDevice> {
  return chooseDevice(await getDevices());
}

function explain(e: unknown, device: SpotifyDevice | null): never {
  if (e instanceof SpotifyError) {
    // Spotify's own words help when the guess below is wrong.
    const why = ` (${e.message.replace(/^Spotify: /, '')})`;
    if (e.status === 404) throw new Error(nothingActive() + why);
    if (e.status === 403) {
      if (/premium/i.test(e.message) || !device) throw new Error(premiumNeeded() + why);
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
      try {
        if (!started) {
          // The device may have changed since the last song (picked in the app).
          device = await activeDevice();
          await playOnDevice(device.id!, uri);
          started = true;
        } else await resumeDevice(device!.id!);
      } catch (e) {
        explain(e, device);
      }
      set(true);
    },
    async pause() {
      try {
        await pauseDevice(device?.id ?? '');
      } catch (e) {
        explain(e, device);
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
