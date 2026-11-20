import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => {
  class SpotifyError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  }
  class RateLimitError extends SpotifyError {
    constructor() {
      super('limit', 429);
    }
  }
  return {
    SpotifyError,
    RateLimitError,
    getDevices: vi.fn(),
    getPlaybackState: vi.fn(),
    playOnDevice: vi.fn(),
    pauseDevice: vi.fn(),
    resumeDevice: vi.fn(),
    transferPlayback: vi.fn(),
  };
});
vi.mock('./playback', () => ({ uriFor: vi.fn(async () => 'spotify:track:abc') }));

import * as api from './api';
import type { PlaybackState, SpotifyDevice } from './api';
import { chooseDevice, createSpotifyConnectPlayback, type ConnectTarget } from './remote';

const mocked = vi.mocked(api);
const song = { id: 's1', title: 'T', artist: 'A', year: 1990 };
const URI = 'spotify:track:abc';

const dev = (over: Partial<SpotifyDevice>): SpotifyDevice => ({ id: 'x', name: 'X', type: 'Computer', is_active: false, is_restricted: false, ...over });
const kitchen = dev({ id: 'k1', name: 'Kitchen', type: 'Speaker' });
const phone = dev({ id: 'p1', name: 'Pixel', type: 'Smartphone' });
const mac = dev({ id: 'm1', name: 'MacBook', type: 'Computer' });
const target = (d: SpotifyDevice): ConnectTarget => ({ id: d.id!, name: d.name, type: d.type });

/**
 * A pretend Spotify: the devices, what plays where, and the quirks the game
 * has to cope with. `ignorePlays` plays are accepted but do nothing (a speaker
 * just woken), and a device that isn't active refuses plays with 404 while
 * `idleRefuses` is set.
 */
function fakeSpotify(devices: SpotifyDevice[]) {
  const s = {
    devices,
    active: devices.find((d) => d.is_active)?.id ?? null,
    state: null as PlaybackState | null,
    ignorePlays: 0,
    idleRefuses: false,
  };
  const byId = (id: string) => s.devices.find((d) => d.id === id)!;
  mocked.getDevices.mockImplementation(async () => s.devices.map((d) => ({ ...d, is_active: d.id === s.active })));
  mocked.getPlaybackState.mockImplementation(async () => s.state);
  mocked.transferPlayback.mockImplementation(async (id) => {
    s.active = id;
    s.state = { device: byId(id), is_playing: false, item: s.state?.item ?? null };
  });
  mocked.playOnDevice.mockImplementation(async (id, uri) => {
    if (s.idleRefuses && s.active !== id) throw new api.SpotifyError('Spotify: Device not found', 404);
    if (s.ignorePlays > 0) return void s.ignorePlays--;
    s.active = id;
    s.state = { device: byId(id), is_playing: true, item: { uri } };
  });
  mocked.pauseDevice.mockImplementation(async () => {
    if (!s.state?.is_playing) throw new api.SpotifyError('Spotify: Player command failed: Restriction violated', 403);
    s.state = { ...s.state, is_playing: false };
  });
  mocked.resumeDevice.mockImplementation(async () => {
    if (!s.state) throw new api.SpotifyError('Spotify: Player command failed: No active device found', 404);
    s.state = { ...s.state, is_playing: true };
  });
  return s;
}

/** Runs a call to its end, timers included (the game waits between asking Spotify). */
async function settle<T>(p: Promise<T>): Promise<T> {
  const result = p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  const r = await result;
  if (!r.ok) throw r.error;
  return r.value;
}

describe('playing on a Spotify Connect device', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('plays on the picked speaker and checks that it really plays, then pauses and resumes there', async () => {
    const spotify = fakeSpotify([{ ...phone, is_active: true }, { ...kitchen }]);
    spotify.state = { device: phone, is_playing: true, item: { uri: 'spotify:track:other' } };
    const p = createSpotifyConnectPlayback(target(kitchen));
    const states: boolean[] = [];
    p.onStateChange((s) => states.push(s));
    await p.prepare(song);
    await settle(p.play());
    expect(mocked.playOnDevice).toHaveBeenLastCalledWith('k1', URI, 0);
    expect(spotify.state).toMatchObject({ device: { id: 'k1' }, is_playing: true });
    await settle(p.pause());
    await settle(p.play());
    expect(mocked.pauseDevice).toHaveBeenCalledWith('k1');
    expect(mocked.resumeDevice).toHaveBeenCalledWith('k1');
    expect(mocked.getDevices).toHaveBeenCalledTimes(1);
    expect(states).toEqual([false, true, false, true]);
  });

  it('wakes an idle speaker by moving playback to it before playing', async () => {
    fakeSpotify([{ ...phone, is_active: true }, { ...kitchen }]);
    const p = createSpotifyConnectPlayback(target(kitchen));
    await p.prepare(song);
    await settle(p.play());
    expect(mocked.transferPlayback).toHaveBeenCalledWith('k1', false);
    expect(mocked.transferPlayback.mock.invocationCallOrder[0]).toBeLessThan(mocked.playOnDevice.mock.invocationCallOrder[0]);
  });

  it('plays straight away on a speaker that is already active', async () => {
    fakeSpotify([{ ...kitchen, is_active: true }]);
    const p = createSpotifyConnectPlayback(target(kitchen));
    await p.prepare(song);
    await settle(p.play());
    expect(mocked.transferPlayback).not.toHaveBeenCalled();
    expect(mocked.playOnDevice).toHaveBeenCalledTimes(1);
  });

  it('sends the song again when Spotify accepted the play but nothing plays', async () => {
    const spotify = fakeSpotify([{ ...kitchen, is_active: true }]);
    spotify.ignorePlays = 1;
    const p = createSpotifyConnectPlayback(target(kitchen));
    await p.prepare(song);
    await settle(p.play());
    expect(mocked.playOnDevice).toHaveBeenCalledTimes(2);
    expect(spotify.state).toMatchObject({ device: { id: 'k1' }, is_playing: true, item: { uri: URI } });
  });

  it('says so when the speaker still doesn’t play', async () => {
    const spotify = fakeSpotify([{ ...kitchen, is_active: true }]);
    spotify.ignorePlays = 99;
    const p = createSpotifyConnectPlayback(target(kitchen));
    const states: boolean[] = [];
    p.onStateChange((s) => states.push(s));
    await p.prepare(song);
    await expect(settle(p.play())).rejects.toThrow(/“Kitchen” didn’t start playing/);
    expect(states).toEqual([false]);
  });

  it('wakes the speaker and tries again when Spotify says it can’t find it', async () => {
    const spotify = fakeSpotify([{ ...kitchen, is_active: true }]);
    spotify.idleRefuses = true;
    spotify.active = null; // listed as active a moment ago, forgotten since
    mocked.getDevices.mockResolvedValueOnce([{ ...kitchen, is_active: true }]);
    const p = createSpotifyConnectPlayback(target(kitchen));
    await p.prepare(song);
    await settle(p.play());
    expect(mocked.transferPlayback).toHaveBeenCalledWith('k1', false);
    expect(mocked.playOnDevice).toHaveBeenCalledTimes(2);
    expect(spotify.state).toMatchObject({ device: { id: 'k1' }, is_playing: true });
  });

  it('plays on a Mac or PC’s Spotify app the same way', async () => {
    fakeSpotify([{ ...phone, is_active: true }, { ...mac }]);
    const p = createSpotifyConnectPlayback(target(mac));
    await p.prepare(song);
    await settle(p.play());
    expect(mocked.playOnDevice).toHaveBeenLastCalledWith('m1', URI, 0);
  });

  it('finds the picked device again when Spotify gives it a new id', async () => {
    fakeSpotify([{ ...kitchen, id: 'k2', is_active: true }]);
    const p = createSpotifyConnectPlayback(target(kitchen));
    await p.prepare(song);
    await settle(p.play());
    expect(mocked.playOnDevice).toHaveBeenLastCalledWith('k2', URI, 0);
  });

  it('says how to wake a picked device Spotify can’t see', async () => {
    fakeSpotify([{ ...phone, is_active: true }]);
    const p = createSpotifyConnectPlayback(target(kitchen));
    await p.prepare(song);
    await expect(settle(p.play())).rejects.toThrow(/can’t see “Kitchen”.*start any song/);
    expect(mocked.playOnDevice).not.toHaveBeenCalled();
  });

  it('doesn’t complain about pausing a song that already stopped', async () => {
    const spotify = fakeSpotify([{ ...kitchen, is_active: true }]);
    const p = createSpotifyConnectPlayback(target(kitchen));
    const states: boolean[] = [];
    p.onStateChange((s) => states.push(s));
    await p.prepare(song);
    await settle(p.play());
    spotify.state = { ...spotify.state!, is_playing: false }; // paused in the Spotify app
    await expect(settle(p.pause())).resolves.toBeUndefined();
    expect(states.at(-1)).toBe(false);
  });

  it('still reports a pause that really failed', async () => {
    fakeSpotify([{ ...kitchen, is_active: true }]);
    const p = createSpotifyConnectPlayback(target(kitchen));
    await p.prepare(song);
    await settle(p.play());
    mocked.pauseDevice.mockRejectedValueOnce(new api.SpotifyError('Spotify: Player command failed: Restriction violated', 403));
    await expect(settle(p.pause())).rejects.toThrow(/won’t let other apps control “Kitchen”/);
  });

  it('starts the song again where it was when the speaker was forgotten during the pause', async () => {
    const spotify = fakeSpotify([{ ...kitchen, is_active: true }]);
    const p = createSpotifyConnectPlayback(target(kitchen));
    await p.prepare(song);
    await settle(p.play());
    await vi.advanceTimersByTimeAsync(30_000);
    await settle(p.pause());
    spotify.state = null; // Spotify forgets a paused player after a few minutes
    spotify.active = null;
    await settle(p.play());
    expect(mocked.playOnDevice).toHaveBeenLastCalledWith('k1', URI, 30_000);
    expect(spotify.state).toMatchObject({ device: { id: 'k1' }, is_playing: true });
  });

  it('needs no check on a device in a private session', async () => {
    fakeSpotify([{ ...kitchen, is_active: true, is_private_session: true }]);
    mocked.getPlaybackState.mockResolvedValue(null);
    const p = createSpotifyConnectPlayback(target(kitchen));
    await p.prepare(song);
    await settle(p.play());
    expect(mocked.getPlaybackState).not.toHaveBeenCalled();
  });

  it('explains a speaker Spotify locks, like a Sonos', async () => {
    fakeSpotify([{ id: null, name: 'Kitchen', type: 'Speaker', is_active: true, is_restricted: true }]);
    const p = createSpotifyConnectPlayback(null);
    await p.prepare(song);
    await expect(settle(p.play())).rejects.toThrow(/won’t let other apps control “Kitchen”/);
  });

  it('turns a 403 on play into the locked-speaker message', async () => {
    fakeSpotify([{ ...phone, is_active: true }]);
    mocked.playOnDevice.mockRejectedValueOnce(new api.SpotifyError('Restriction violated', 403));
    const p = createSpotifyConnectPlayback(null);
    await p.prepare(song);
    await expect(settle(p.play())).rejects.toThrow(/won’t let other apps control “Pixel”.*\(Restriction violated\)/);
  });

  it('says when Premium is missing', async () => {
    fakeSpotify([{ ...phone, is_active: true }]);
    mocked.playOnDevice.mockRejectedValueOnce(new api.SpotifyError('Spotify: Player command failed: Premium required', 403));
    const p = createSpotifyConnectPlayback(null);
    await p.prepare(song);
    await expect(settle(p.play())).rejects.toThrow(/needs Spotify Premium/);
  });

  it('asks for the device again for the next song, after pausing the last one', async () => {
    fakeSpotify([{ ...phone, is_active: true }]);
    const p = createSpotifyConnectPlayback(null);
    await p.prepare(song);
    await settle(p.play());
    await p.prepare({ ...song, id: 's2' });
    expect(mocked.pauseDevice).toHaveBeenCalledWith('p1');
    await settle(p.play());
    expect(mocked.getDevices).toHaveBeenCalledTimes(2);
  });

  it('counts pausing an app that went away (and its music with it) as paused', async () => {
    const spotify = fakeSpotify([{ ...phone, is_active: true }]);
    const p = createSpotifyConnectPlayback(null);
    await p.prepare(song);
    await settle(p.play());
    spotify.state = null;
    mocked.pauseDevice.mockRejectedValueOnce(new api.SpotifyError('Spotify: Device not found', 404));
    await expect(settle(p.pause())).resolves.toBeUndefined();
  });

  it('counts a resume Spotify refuses while the song already plays as playing', async () => {
    fakeSpotify([{ ...phone, is_active: true }]);
    const p = createSpotifyConnectPlayback(null);
    await p.prepare(song);
    await settle(p.play());
    await settle(p.pause());
    mocked.resumeDevice.mockImplementationOnce(async () => {
      await mocked.playOnDevice.getMockImplementation()!('p1', URI); // it did resume…
      throw new api.SpotifyError('Spotify: Player command failed: Restriction violated', 403); // …and said no
    });
    await expect(settle(p.play())).resolves.toBeUndefined();
    expect(mocked.getDevices).toHaveBeenCalledTimes(1);
  });

  it('asks for a new login when the old one lacks the permission', async () => {
    mocked.getDevices.mockRejectedValue(new api.SpotifyError('Spotify: Insufficient client scope', 403));
    const p = createSpotifyConnectPlayback(target(kitchen));
    await p.prepare(song);
    await expect(settle(p.play())).rejects.toThrow(/log in again/);
  });

  it('following the Spotify app, plays the next song where the last one played, not on the phone', async () => {
    const spotify = fakeSpotify([{ ...kitchen, is_active: true }, { ...phone }]);
    const p = createSpotifyConnectPlayback(null);
    await p.prepare(song);
    await settle(p.play());
    await p.prepare({ ...song, id: 's2' });
    spotify.active = null; // the speaker was forgotten during the reveal
    spotify.state = null;
    await settle(p.play());
    expect(mocked.playOnDevice).toHaveBeenLastCalledWith('k1', URI, 0);
  });
});

describe('choosing the device', () => {
  it('finds a picked device by id, else by name', () => {
    expect(chooseDevice([dev({ id: 'a', name: 'Kitchen' }), kitchen], target(kitchen)).id).toBe('k1');
    expect(chooseDevice([phone, dev({ id: 'new', name: 'Kitchen', type: 'Speaker' })], target(kitchen)).id).toBe('new');
  });

  it('doesn’t play anywhere else when the picked device is missing or locked', () => {
    expect(() => chooseDevice([{ ...phone, is_active: true }], target(kitchen))).toThrow(/can’t see “Kitchen”/);
    expect(() => chooseDevice([{ ...kitchen, is_restricted: true }], target(kitchen))).toThrow(/won’t let other apps control “Kitchen”/);
  });

  it('skips the game’s own old player, even when Spotify still calls it active', () => {
    expect(chooseDevice([dev({ id: 'own', name: 'The Music Quiz', is_active: true }), phone], null).id).toBe('p1');
    expect(() => chooseDevice([dev({ id: 'own', name: 'The Music Quiz' })], null)).toThrow(/can’t see any speaker/);
  });

  it('follows the active device, else the last one used, else the only one open', () => {
    expect(chooseDevice([kitchen, { ...mac, is_active: true }], null).id).toBe('m1');
    expect(chooseDevice([phone, kitchen], null, target(kitchen)).id).toBe('k1');
    expect(chooseDevice([dev({ id: 'tv', type: 'TV' })], null).id).toBe('tv');
  });

  it('asks which one when nothing is active and several are open', () => {
    expect(() => chooseDevice([phone, kitchen], null)).toThrow(/“Pixel”, “Kitchen”.*Pick one under 🔊/);
  });

  it('explains a locked active device or a locked only device', () => {
    expect(() => chooseDevice([dev({ name: 'Kitchen', is_active: true, is_restricted: true })], null)).toThrow(/“Kitchen”/);
    expect(() => chooseDevice([dev({ name: 'Kitchen', is_restricted: true })], null)).toThrow(/“Kitchen”/);
    expect(() => chooseDevice([], null)).toThrow(/can’t see any speaker/);
  });
});
