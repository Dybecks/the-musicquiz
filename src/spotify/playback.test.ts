import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  findTrackUri: vi.fn(async () => 'spotify:track:abc'),
  getDevices: vi.fn(),
  pauseDevice: vi.fn(async () => {}),
  playOnDevice: vi.fn(async () => {}),
  resumeDevice: vi.fn(async () => {}),
  transferTo: vi.fn(async () => {}),
}));
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), ...api }));
vi.mock('./auth', () => ({ getAccessToken: async () => 't', getClientId: () => 'c' }));

import { SpotifyError } from './api';
import { createSpeakerPlayback } from './playback';

const song = { id: 's', title: 'T', artist: 'A', year: 1990 } as never;

describe('createSpeakerPlayback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('costs one request to start a song and one per pause or resume', async () => {
    const p = createSpeakerPlayback({ id: 'sonos', name: 'Kitchen' });
    const states: boolean[] = [];
    p.onStateChange((s) => states.push(s));
    await p.prepare(song);
    await p.play();
    await p.pause();
    await p.play();
    expect(api.playOnDevice).toHaveBeenCalledTimes(1);
    expect(api.playOnDevice).toHaveBeenCalledWith('sonos', 'spotify:track:abc');
    expect(api.pauseDevice).toHaveBeenCalledTimes(1);
    expect(api.resumeDevice).toHaveBeenCalledTimes(1);
    expect(api.getDevices).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe(true);
  });

  it('finds a sleeping speaker again by name and wakes it', async () => {
    api.playOnDevice.mockRejectedValueOnce(new SpotifyError('Device not found', 404));
    api.getDevices.mockResolvedValueOnce([{ id: 'new-id', name: 'Kitchen', type: 'Speaker' }]);
    const p = createSpeakerPlayback({ id: 'old-id', name: 'Kitchen' });
    await p.prepare(song);
    await p.play();
    expect(api.transferTo).toHaveBeenCalledWith('new-id');
    expect(api.playOnDevice).toHaveBeenLastCalledWith('new-id', 'spotify:track:abc');
  });

  it('says what to do when the speaker is gone', async () => {
    api.playOnDevice.mockRejectedValueOnce(new SpotifyError('Device not found', 404));
    api.getDevices.mockResolvedValueOnce([]);
    const p = createSpeakerPlayback({ id: 'x', name: 'Kitchen' });
    await p.prepare(song);
    await expect(p.play()).rejects.toThrow(/Kitchen isn't reachable/);
  });
});
