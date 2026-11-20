import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => {
  class SpotifyError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  }
  return { SpotifyError, getDevices: vi.fn(), playOnDevice: vi.fn(), pauseDevice: vi.fn(), resumeDevice: vi.fn() };
});
vi.mock('./playback', () => ({ uriFor: vi.fn(async () => 'spotify:track:abc') }));

import * as api from './api';
import { chooseDevice, createSpotifyAppPlayback } from './remote';

const mocked = vi.mocked(api);
const song = { id: 's1', title: 'T', artist: 'A', year: 1990 };
const phone = { id: 'phone1', name: 'Pixel', type: 'Smartphone', is_active: true, is_restricted: false };

describe('steering the Spotify app', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.pauseDevice.mockResolvedValue();
    mocked.playOnDevice.mockResolvedValue();
    mocked.resumeDevice.mockResolvedValue();
  });

  it('plays on the device the app is using, then pauses and resumes there', async () => {
    mocked.getDevices.mockResolvedValue([{ ...phone, id: 'tv', name: 'TV', is_active: false }, phone]);
    const p = createSpotifyAppPlayback();
    const states: boolean[] = [];
    p.onStateChange((s) => states.push(s));
    await p.prepare(song);
    await p.play();
    expect(mocked.playOnDevice).toHaveBeenCalledWith('phone1', 'spotify:track:abc');
    await p.pause();
    await p.play();
    expect(mocked.pauseDevice).toHaveBeenCalledWith('phone1');
    expect(mocked.resumeDevice).toHaveBeenCalledWith('phone1');
    expect(mocked.getDevices).toHaveBeenCalledTimes(1);
    expect(states).toEqual([false, true, false, true]);
  });

  it('says how to start the app when Spotify sees no app', async () => {
    mocked.getDevices.mockResolvedValue([{ ...phone, name: 'The Music Quiz', is_active: true }]);
    const p = createSpotifyAppPlayback();
    await p.prepare(song);
    await expect(p.play()).rejects.toThrow(/isn’t open anywhere/);
    expect(mocked.playOnDevice).not.toHaveBeenCalled();
  });

  it('explains a speaker Spotify locks, like a Sonos', async () => {
    mocked.getDevices.mockResolvedValue([{ id: null, name: 'Kitchen', type: 'Speaker', is_active: true, is_restricted: true }]);
    const p = createSpotifyAppPlayback();
    await p.prepare(song);
    await expect(p.play()).rejects.toThrow(/won’t let other apps control “Kitchen”/);
  });

  it('turns a 403 on play into the locked-speaker message', async () => {
    mocked.getDevices.mockResolvedValue([phone]);
    mocked.playOnDevice.mockRejectedValueOnce(new api.SpotifyError('Restriction violated', 403));
    const p = createSpotifyAppPlayback();
    await p.prepare(song);
    await expect(p.play()).rejects.toThrow(/won’t let other apps control “Pixel”.*\(Restriction violated\)/);
  });

  it('says when Premium is missing', async () => {
    mocked.getDevices.mockResolvedValue([phone]);
    mocked.playOnDevice.mockRejectedValueOnce(new api.SpotifyError('Spotify: Player command failed: Premium required', 403));
    const p = createSpotifyAppPlayback();
    await p.prepare(song);
    await expect(p.play()).rejects.toThrow(/needs Spotify Premium/);
  });

  it('asks the device again for the next song', async () => {
    mocked.getDevices.mockResolvedValue([phone]);
    const p = createSpotifyAppPlayback();
    await p.prepare(song);
    await p.play();
    await p.prepare({ ...song, id: 's2' });
    expect(mocked.pauseDevice).toHaveBeenCalledWith('phone1');
    await p.play();
    expect(mocked.getDevices).toHaveBeenCalledTimes(2);
  });
});

describe('choosing the device', () => {
  const d = (over: Partial<api.SpotifyDevice>) => ({ id: 'x', name: 'X', type: 'Computer', is_active: false, is_restricted: false, ...over });

  it('skips the game’s own old player, even when Spotify still calls it active', () => {
    expect(chooseDevice([d({ id: 'own', name: 'The Music Quiz', is_active: true }), d({ id: 'p', type: 'Smartphone' })]).id).toBe('p');
  });

  it('prefers the active device, else an idle phone, else any open one', () => {
    expect(chooseDevice([d({ id: 'tv', type: 'TV' }), d({ id: 'a', is_active: true })]).id).toBe('a');
    expect(chooseDevice([d({ id: 'tv', type: 'TV' }), d({ id: 'p', type: 'Smartphone' })]).id).toBe('p');
    expect(chooseDevice([d({ id: 'tv', type: 'TV' })]).id).toBe('tv');
  });

  it('explains a locked active device or a locked only device', () => {
    expect(() => chooseDevice([d({ name: 'Kitchen', is_active: true, is_restricted: true })])).toThrow(/“Kitchen”/);
    expect(() => chooseDevice([d({ name: 'Kitchen', is_restricted: true })])).toThrow(/“Kitchen”/);
    expect(() => chooseDevice([])).toThrow(/isn’t open anywhere/);
  });
});
