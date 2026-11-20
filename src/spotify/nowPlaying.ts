/**
 * Keep the mystery song's title off lock screens, Control Center, car displays
 * and AirPlay/Bluetooth receivers (a Sonos app shows what the sender reports).
 *
 * Both Spotify players run in a cross-origin iframe and report the real track
 * through the Media Session API. Chrome only routes media info from a frame
 * that is itself playing something (the top-most such frame wins), so setting
 * navigator.mediaSession here does nothing on its own. While the song is
 * hidden, this page therefore also plays a silent, looping clip: that makes
 * the game the frame the browser asks, and it reports "Mystery song".
 *
 * Not on iPhone/iPad: Safari there may pause the song when another sound
 * starts in the same page, so only the metadata is set (best effort).
 */

export interface MysteryControls {
  play(): void;
  pause(): void;
}

let audio: HTMLAudioElement | null = null;

/** A 10-second silent WAV (8 kHz, 8-bit mono). Longer than Chrome's 5 s "short sound" cut-off. */
function silentClip(): string {
  const rate = 8000;
  const samples = rate * 10;
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true); // byte rate
  v.setUint16(32, 1, true); // block align
  v.setUint16(34, 8, true); // bits per sample
  str(36, 'data');
  v.setUint32(40, samples, true);
  new Uint8Array(buf, 44).fill(128); // 8-bit PCM silence
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export function isAppleTouch(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

function iconUrl(size: number): string {
  return new URL(`icons/icon-${size}.png`, document.baseURI).href;
}

/**
 * Report "Mystery song" while `playing` (or paused mid-song). Lock-screen and
 * headphone play/pause go to `controls`, so they still control the real song.
 */
export function hideNowPlaying(playing: boolean, controls: MysteryControls): void {
  const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
  if (ms && typeof MediaMetadata !== 'undefined') {
    ms.metadata = new MediaMetadata({
      title: 'Mystery song',
      artist: 'The Music Quiz',
      artwork: [192, 512].map((s) => ({ src: iconUrl(s), sizes: `${s}x${s}`, type: 'image/png' })),
    });
    ms.playbackState = playing ? 'playing' : 'paused';
    for (const action of ['previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto'] as const) {
      try {
        ms.setActionHandler(action, null);
      } catch {
        /* action not supported */
      }
    }
    ms.setActionHandler('play', () => controls.play());
    ms.setActionHandler('pause', () => controls.pause());
  }
  if (isAppleTouch() || typeof Audio === 'undefined') return;
  if (!audio) {
    audio = new Audio(silentClip());
    audio.loop = true;
  }
  if (playing) void audio.play().catch(() => {});
  else audio.pause();
}

/** Stop covering: after the reveal the title is no secret. */
export function showNowPlaying(): void {
  audio?.pause();
  const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
  if (!ms) return;
  ms.metadata = null;
  ms.playbackState = 'none';
  ms.setActionHandler('play', null);
  ms.setActionHandler('pause', null);
}
