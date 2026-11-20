/**
 * Keep the mystery song's title off lock screens, Control Center, car displays
 * and AirPlay/Bluetooth receivers (a Sonos app shows what the sender reports).
 *
 * Both Spotify players run in a cross-origin iframe and report the real track
 * through the Media Session API. Chrome only routes media info from a frame
 * that has a player in the tab's media session (playing, or paused but still
 * held), preferring the top-most such frame. Setting navigator.mediaSession
 * here does nothing on its own, so while the song is hidden this page also
 * plays a silent, looping clip: the browser then asks the game, and it
 * reports "Mystery song".
 *
 * Not on iPhone/iPad: Safari there may pause the song when another sound
 * starts in the same page, so only the metadata is set (best effort).
 */

export interface MysteryControls {
  play(): void;
  pause(): void;
}

let audio: HTMLAudioElement | null = null;
let clipUrl: string | null = null;
/** Whether the cover is on, and whether its clip should be playing. */
let covering = false;
let wantPlaying = false;
let controls: MysteryControls | null = null;

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

function clipSupported(): boolean {
  return typeof Audio !== 'undefined' && typeof URL.createObjectURL === 'function' && !isAppleTouch();
}

function mediaSession(): MediaSession | undefined {
  return typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
}

function setHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void {
  try {
    mediaSession()?.setActionHandler(action, handler);
  } catch {
    /* action not supported */
  }
}

function clip(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.loop = true;
    // The browser paused the clip by itself (headphones unplugged, a media key
    // that skipped our handler...). Pause the song too rather than let the
    // browser fall back to Spotify's frame, which shows the title.
    audio.addEventListener('pause', () => {
      if (covering && wantPlaying) {
        wantPlaying = false;
        controls?.pause();
      }
    });
  }
  clipUrl ??= silentClip();
  if (audio.getAttribute('src') !== clipUrl) audio.src = clipUrl;
  return audio;
}

function setClipPlaying(playing: boolean): void {
  wantPlaying = playing;
  if (!clipSupported()) return;
  if (playing) void clip().play().catch(() => {});
  else audio?.pause();
}

/**
 * Start the silent clip right away. Call it inside the click that starts the
 * song: Safari only lets a page play sound from a user gesture, and a
 * Spotify state change arrives too late for that.
 */
export function primeNowPlaying(): void {
  covering = true;
  setClipPlaying(true);
}

/** The song didn't start after all: stop the primed clip. */
export function unprimeNowPlaying(): void {
  setClipPlaying(false);
}

/**
 * Report "Mystery song" while `playing` (or paused mid-song). Lock-screen and
 * headphone play/pause go to `ctrl`, so they still control the real song.
 */
export function hideNowPlaying(playing: boolean, ctrl: MysteryControls): void {
  covering = true;
  controls = ctrl;
  const ms = mediaSession();
  if (ms && typeof MediaMetadata !== 'undefined') {
    ms.metadata = new MediaMetadata({
      title: 'Mystery song',
      artist: 'The Music Quiz',
      artwork: [192, 512].map((s) => ({
        src: new URL(`${import.meta.env.BASE_URL}icons/icon-${s}.png`, location.origin).href,
        sizes: `${s}x${s}`,
        type: 'image/png',
      })),
    });
    ms.playbackState = playing ? 'playing' : 'paused';
    setHandler('play', () => ctrl.play());
    setHandler('pause', () => ctrl.pause());
  }
  setClipPlaying(playing);
}

/** Stop covering: after the reveal the title is no secret. */
export function showNowPlaying(): void {
  covering = false;
  controls = null;
  setClipPlaying(false);
  // A paused player can stay in the tab's media session; drop the clip's source
  // so lock-screen buttons don't resume the silent clip instead of the song.
  if (audio) {
    audio.removeAttribute('src');
    audio.load();
  }
  const ms = mediaSession();
  if (!ms) return;
  ms.metadata = null;
  ms.playbackState = 'none';
  setHandler('play', null);
  setHandler('pause', null);
}
