import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ getAccessToken: async () => 'token' }));

const reply = (status: number, headers: Record<string, string> = {}) =>
  new Response(status === 200 ? '{"ok":true}' : '{}', { status, headers });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe('spotifyGet and rate limits', () => {
  it('waits as long as Spotify asks, tells listeners, and holds back other requests meanwhile', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(reply(429, { 'Retry-After': '600' })).mockImplementation(async () => reply(200));
    vi.stubGlobal('fetch', fetch);
    const { spotifyGet, onSpotifyWait } = await import('./api');
    const waits: number[] = [];
    onSpotifyWait((until) => waits.push(until));
    const first = spotifyGet('/search?q=a');
    await vi.advanceTimersByTimeAsync(1000);
    const second = spotifyGet('/search?q=b');
    await vi.advanceTimersByTimeAsync(500_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(waits).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100_000);
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('gives up after being refused again and again', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => reply(429, { 'Retry-After': '1' }));
    vi.stubGlobal('fetch', fetch);
    const { spotifyGet, RateLimitError } = await import('./api');
    const result = spotifyGet('/me');
    const check = expect(result).rejects.toBeInstanceOf(RateLimitError);
    await vi.advanceTimersByTimeAsync(10_000);
    await check;
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('waits out a short Retry-After and tries again', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(reply(429, { 'Retry-After': '2' })).mockResolvedValueOnce(reply(200));
    vi.stubGlobal('fetch', fetch);
    const { spotifyGet } = await import('./api');
    const result = spotifyGet<{ ok: boolean }>('/me');
    await vi.advanceTimersByTimeAsync(2100);
    await expect(result).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
