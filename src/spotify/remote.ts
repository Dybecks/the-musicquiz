import {
  getDevices,
  getPlaybackState,
  pauseDevice,
  playOnDevice,
  RateLimitError,
  resumeDevice,
  SpotifyError,
  transferPlayback,
  type PlaybackState,
  type SpotifyDevice,
} from './api';
import { uriFor, type Playback } from './playback';
import { msg } from '../i18n';

/**
 * Plays the songs on a Spotify Connect device: a speaker, TV, game console,
 * the Spotify app on a computer (PC or Mac) or on a phone, anything the
 * account's Spotify can play on. Nothing plays on this device. Needs Spotify
 * Premium.
 *
 * The device is one picked under 🔊 (found again by its name if Spotify gave
 * it a new id), or, with none picked, wherever the Spotify app plays right now.
 * Then the commands carry no device id, so a speaker Spotify marks as
 * restricted (often a Sonos) is still tried: only Spotify's answer decides.
 *
 * Spotify's commands are unreliable on a device that has gone idle: a play
 * aimed at it can fail (404, 5xx) or be accepted and do nothing, and Spotify
 * forgets a paused device after a few minutes. So an idle device is first made
 * the active one (a transfer), every start is checked against what Spotify says
 * is playing and sent once more if it didn't take, and a resume that finds the
 * device gone starts the song again there, where it was.
 *
 * A start costs 3 requests when all goes well (the device list, play, one
 * check), up to about 10 for a sleepy speaker. Nothing is polled while the
 * song plays, so pausing in the Spotify app itself isn't seen here.
 */

/** A device picked under 🔊, as saved. */
export interface ConnectTarget {
  id: string;
  name: string;
  type: string;
}

// The texts are in src/i18n (errors.connect…), in the game's language.
const nothingOpen = () => msg().errors.connectNothingOpen;
const scopeMissing = () => msg().errors.connectScopeMissing;
const notListed = (t: ConnectTarget) => msg().errors.connectNotListed(t.name);
const restricted = (d: SpotifyDevice) => msg().errors.connectRestricted(d.name);
const severalOpen = (ds: SpotifyDevice[]) => msg().errors.connectSeveralOpen(ds.map((d) => d.name));
const didNotStart = (d: SpotifyDevice) => msg().errors.connectDidNotStart(d.name);
const premiumNeeded = () => msg().errors.connectPremium;

/** A login from before the playback permissions were asked for (or none at all). */
const loginLacking = (e: unknown) => e instanceof SpotifyError && (/scope/i.test(e.message) || e.status === 401);

/** Why the list of devices couldn't be fetched, in words. */
export const listError = (e: unknown) => (loginLacking(e) ? scopeMissing() : e instanceof Error ? e.message : String(e));

/** The game's own in-browser player. Spotify keeps listing it for a while after it's gone. */
const OWN_PLAYER = 'The Music Quiz';

/** The devices worth offering: all but the game's own in-browser player. */
export const connectDevices = (all: SpotifyDevice[]) => all.filter((d) => d.name !== OWN_PLAYER);

const usable = (d: SpotifyDevice) => !!d.id && !d.is_restricted;

/** A saved device in Spotify's list: by id, or by name if it came back with a new id (Google Cast ones do). */
export function findTarget(devices: SpotifyDevice[], t: ConnectTarget): SpotifyDevice | undefined {
  return devices.find((d) => d.id === t.id) ?? devices.find((d) => d.name === t.name && d.type === t.type) ?? devices.find((d) => d.name === t.name);
}

/**
 * The device to play on: the picked one, or with none picked the one the
 * Spotify app uses now, else the one the last song played on, else the only
 * one open.
 */
export function chooseDevice(all: SpotifyDevice[], target: ConnectTarget | null, lastUsed: ConnectTarget | null = null): SpotifyDevice {
  const devices = connectDevices(all);
  const checked = (d: SpotifyDevice) => {
    if (!usable(d)) throw new Error(restricted(d));
    return d;
  };
  if (target) {
    const d = findTarget(devices, target);
    if (!d) throw new Error(notListed(target));
    return checked(d);
  }
  const active = devices.find((d) => d.is_active);
  if (active) return checked(active);
  // Spotify forgets a paused device after a few minutes: carry on where the last song played.
  const last = lastUsed && findTarget(devices, lastUsed);
  if (last && usable(last)) return last;
  const open = devices.filter(usable);
  if (open.length === 1) return open[0];
  if (open.length > 1) throw new Error(severalOpen(open));
  const locked = devices.find((d) => d.is_restricted);
  throw new Error(locked ? restricted(locked) : nothingOpen());
}

/** Where "Wherever Spotify plays" sends the commands. */
export interface WhereverChoice {
  /** The device as Spotify lists it, or null when it lists none worth naming. */
  device: SpotifyDevice | null;
  /** The device id to send, or '' for "the device Spotify plays on now". */
  id: string;
}

/**
 * The device to play on with none picked. An active device gets the commands
 * with no device id at all, even one Spotify marks as restricted or lists
 * without an id (often a Sonos): only Spotify's own answer to the play says
 * whether it is really locked. With nothing active, the last device used or
 * the only one open, and with none of those a play to wherever Spotify plays
 * (it may play on a speaker it doesn't list).
 */
export function chooseWherever(all: SpotifyDevice[], lastUsed: ConnectTarget | null = null): WhereverChoice {
  const devices = connectDevices(all);
  const active = devices.find((d) => d.is_active);
  if (active) return { device: active, id: '' };
  const last = lastUsed && findTarget(devices, lastUsed);
  if (last && usable(last)) return { device: last, id: last.id! };
  const open = devices.filter(usable);
  if (open.length === 1) return { device: open[0], id: open[0].id! };
  if (open.length > 1) throw new Error(severalOpen(open));
  return { device: devices.find((d) => d.is_restricted) ?? null, id: '' };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Spotify's answer when a device is asleep or slow: worth waking it and trying again. */
const flaky = (e: unknown) => e instanceof SpotifyError && (e.status === 404 || e.status >= 500);

/** The song (or with no uri, anything) plays on the device. */
export const playsOn = (s: PlaybackState | null, id: string, uri?: string) =>
  !!s && (!id || s.device?.id === id) && s.is_playing && (!uri || s.item?.uri === uri || s.item?.linked_from?.uri === uri);

/** Asks Spotify what plays until `ok` holds: up to four times over about three seconds. */
async function until(ok: (s: PlaybackState | null) => boolean): Promise<boolean> {
  for (const ms of [500, 700, 900, 1100]) {
    await wait(ms);
    const s = await getPlaybackState().catch((e) => {
      if (e instanceof RateLimitError) throw e;
      return null;
    });
    if (ok(s)) return true;
  }
  return false;
}

/** Makes an idle device the active one: a play aimed straight at it often fails or does nothing. */
async function wake(d: SpotifyDevice): Promise<void> {
  try {
    await transferPlayback(d.id!, false);
  } catch (e) {
    // Spotify can refuse a transfer when nothing is active anywhere; the play still wakes most devices.
    if (e instanceof RateLimitError) throw e;
    return;
  }
  // The transfer may not have finished when Spotify answers, and a play sent too early goes nowhere.
  await until((s) => s?.device?.id === d.id);
}

/**
 * Starts the song on the device and makes sure it really plays there. With
 * `id` '' it goes to the device Spotify plays on now, with no device id.
 */
export async function startOn(d: SpotifyDevice | null, uri: string, positionMs = 0, id = d?.id ?? ''): Promise<void> {
  if (id && d && !d.is_active) await wake(d);
  try {
    await playOnDevice(id, uri, positionMs);
  } catch (e) {
    if (!flaky(e) || !id || !d) throw e;
    await wake(d);
    await playOnDevice(id, uri, positionMs);
  }
  // In a private session Spotify doesn't say what plays, so there is nothing to check.
  if (d?.is_private_session) return;
  if (await until((s) => playsOn(s, id, uri))) return;
  // Accepted but nothing happened, as a speaker just woken sometimes does with the first command.
  await playOnDevice(id, uri, positionMs);
  if (!(await until((s) => playsOn(s, id)))) throw new Error(d ? didNotStart(d) : nothingOpen());
}

function explain(e: unknown, device: SpotifyDevice | null): never {
  if (e instanceof SpotifyError && !(e instanceof RateLimitError)) {
    // Spotify's own words help when the guess below is wrong.
    const why = ` (${e.message.replace(/^Spotify: /, '')})`;
    if (loginLacking(e)) throw new Error(scopeMissing() + why);
    if (/premium/i.test(e.message)) throw new Error(premiumNeeded() + why);
    if (e.status === 404 && !device) throw new Error(nothingOpen() + why);
    if (flaky(e)) throw new Error((device ? didNotStart(device) : nothingOpen()) + why);
    if (e.status === 403) throw new Error((device ? restricted(device) : msg().errors.connectCantControl) + why);
  }
  throw e;
}

/** Plays on the picked device, or with `target` null wherever the Spotify app plays. */
export function createSpotifyConnectPlayback(target: ConnectTarget | null): Playback {
  let listener: (playing: boolean) => void = () => {};
  let uri: string | null = null;
  let device: SpotifyDevice | null = null;
  /** The device id the commands go to: '' is wherever Spotify plays now. */
  let cmdId = '';
  /** Where the last song played, for when Spotify has forgotten the device by the next one. */
  let lastUsed: ConnectTarget | null = null;
  let started = false;
  let playing = false;
  /** Roughly how far into the song it is, to carry on there if the device has to be woken again. */
  let playedMs = 0;
  let since = 0;
  const set = (p: boolean) => {
    if (p && !playing) since = Date.now();
    if (!p && playing) playedMs += Date.now() - since;
    playing = p;
    listener(p);
  };

  /** Finds the device again (it may have changed, or have a new id) and starts the song on it. */
  const begin = async (fromMs: number) => {
    const devices = await getDevices();
    if (target) {
      device = chooseDevice(devices, target);
      cmdId = device.id!;
    } else ({ device, id: cmdId } = chooseWherever(devices, lastUsed));
    await startOn(device, uri!, fromMs, cmdId);
    if (device?.id) lastUsed = { id: device.id, name: device.name, type: device.type };
    playedMs = fromMs;
  };

  const resume = async () => {
    try {
      await resumeDevice(cmdId);
      return;
    } catch (e) {
      if (!(e instanceof SpotifyError) || e instanceof RateLimitError) throw e;
      // Spotify sometimes refuses a command that worked anyway.
      if (playsOn(await getPlaybackState().catch(() => null), cmdId, uri!)) return;
    }
    // The device went idle during the pause (Spotify forgets a paused device after
    // a few minutes): start the song on it again, where it was.
    await begin(playedMs);
  };

  return {
    kind: 'spotify-connect',
    async prepare(song) {
      if (playing && started) await pauseDevice(cmdId).catch(() => {});
      set(false);
      started = false;
      playedMs = 0;
      uri = await uriFor(song);
    },
    async play() {
      if (!uri) return;
      try {
        if (!started) {
          await begin(0);
          started = true;
        } else await resume();
      } catch (e) {
        explain(e, device);
      }
      set(true);
    },
    async pause() {
      if (started) {
        try {
          await pauseDevice(cmdId);
        } catch (e) {
          // Spotify answers 403 to pausing a song that already stopped (it ended, or was
          // paused in the app), and sometimes to a pause that worked. Only a song still
          // playing there means the pause failed.
          if (playsOn(await getPlaybackState().catch(() => null), cmdId)) explain(e, device);
        }
      }
      set(false);
    },
    async stop() {
      if (playing && started) await pauseDevice(cmdId).catch(() => {});
      set(false);
      uri = null;
      started = false;
      playedMs = 0;
    },
    onStateChange(cb) {
      listener = cb;
    },
    destroy() {
      if (playing && started) void pauseDevice(cmdId).catch(() => {});
      listener = () => {};
    },
  };
}
