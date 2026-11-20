import { getDevices, pauseDevice, playOnDevice, resumeDevice, SpotifyError, type SpotifyDevice } from './api';
import { uriFor, type Playback } from './playback';

/**
 * Steers the Spotify app instead of playing here: each song is started on
 * the device the Spotify app plays on right now (the phone itself, or a
 * speaker picked in the app, like a Sonos or a TV). Needs Spotify Premium.
 *
 * Starting a song costs two requests (find the device, play) and each pause
 * or resume one; nothing is polled, so pausing in the Spotify app itself
 * isn't seen here.
 */

const NOTHING_ACTIVE =
  'Spotify isn’t playing anywhere right now. Open the Spotify app, pick the speaker (the speaker icon at the bottom of a playing song), start any song, then press Play here again.';

const restricted = (d: SpotifyDevice) =>
  `Spotify won’t let other apps control “${d.name}”. If it’s a Sonos, pick it in the Spotify app’s device list (the speaker icon), not in the Sonos app, start a song there and try again. Otherwise choose another speaker under 🔊.`;

const premiumNeeded = 'Steering the Spotify app needs Spotify Premium.';

async function activeDevice(): Promise<SpotifyDevice> {
  const active = (await getDevices()).find((d) => d.is_active);
  if (!active) throw new Error(NOTHING_ACTIVE);
  if (active.is_restricted || !active.id) throw new Error(restricted(active));
  return active;
}

function explain(e: unknown, device: SpotifyDevice | null): never {
  if (e instanceof SpotifyError) {
    if (e.status === 404) throw new Error(NOTHING_ACTIVE);
    if (e.status === 403) throw new Error(device ? restricted(device) : premiumNeeded);
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
