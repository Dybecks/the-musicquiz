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
  it('waits out a pause of up to two minutes, tells listeners, and holds back other requests meanwhile', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(reply(429, { 'Retry-After': '90' })).mockImplementation(async () => reply(200));
    vi.stubGlobal('fetch', fetch);
    const { spotifyGet, onSpotifyWait } = await import('./api');
    const waits: number[] = [];
    onSpotifyWait((until) => waits.push(until));
    const first = spotifyGet('/search?q=a');
    await vi.advanceTimersByTimeAsync(1000);
    const second = spotifyGet('/search?q=b');
    await vi.advanceTimersByTimeAsync(80_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(waits).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('stops at once when the quota is used up, and sends nothing more until then', async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: { status: 429, message: 'Too many requests', reason: 'QUOTA_EXCEEDED' } }), { status: 429, headers: { 'Retry-After': '68167' } }),
    );
    vi.stubGlobal('fetch', fetch);
    const { spotifyGet, spotifyBlockedUntil, RateLimitError } = await import('./api');
    await expect(spotifyGet('/search?q=a')).rejects.toBeInstanceOf(RateLimitError);
    await expect(spotifyGet('/search?q=b')).rejects.toBeInstanceOf(RateLimitError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(spotifyBlockedUntil()! - Date.now()).toBeGreaterThan(68_000_000);
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
