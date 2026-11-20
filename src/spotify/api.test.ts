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
  it('stops at a long Retry-After, and holds back every later request without sending it', async () => {
    const fetch = vi.fn(async () => reply(429, { 'Retry-After': '3600' }));
    vi.stubGlobal('fetch', fetch);
    const { spotifyGet, RateLimitError } = await import('./api');
    await expect(spotifyGet('/search?q=a')).rejects.toBeInstanceOf(RateLimitError);
    await expect(spotifyGet('/search?q=b')).rejects.toThrow(/wait about 60 minutes/);
    expect(fetch).toHaveBeenCalledTimes(1);
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
