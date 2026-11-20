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
import { createSpotifyAppPlayback } from './remote';

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

  it('says how to start the app when nothing is playing', async () => {
    mocked.getDevices.mockResolvedValue([{ ...phone, is_active: false }]);
    const p = createSpotifyAppPlayback();
    await p.prepare(song);
    await expect(p.play()).rejects.toThrow(/isn’t playing anywhere/);
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
    await expect(p.play()).rejects.toThrow(/won’t let other apps control “Pixel”/);
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
