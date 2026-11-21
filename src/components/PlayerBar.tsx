import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Progress } from '../spotify/playback';
import { useT } from '../i18n';

/** A progress report, and when it arrived (performance.now()). */
export type Clock = Progress & { at: number };

interface Props {
  playing: boolean;
  /** The song can be played (or paused) right now. */
  canPlay: boolean;
  /** Shown instead of the play button's job while the song isn't ready, e.g. "Finding song…". */
  status: string | null;
  progress: Clock;
  onToggle: () => void;
  /** Jumps into the song; leave out where that isn't possible. */
  onSeek?: (ms: number) => void;
  /** Skips the song; leave out once it has been guessed. */
  onSkip?: () => void;
  /** No audio here: no play button or progress, just `note`. */
  silent?: boolean;
  note?: string;
  /** More buttons at the end of the bar. */
  extra?: ReactNode;
}

const time = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * The song player, as a slim bar at the bottom of the screen: play or pause,
 * how far into the song (drag to jump), and skip.
 */
export function PlayerBar({ playing, canPlay, status, progress, onToggle, onSeek, onSkip, silent, note, extra }: Props) {
  const tg = useT().game;
  const [, tick] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const range = useRef<HTMLInputElement>(null);

  // Between the player's reports the position is counted here.
  const now = performance.now();
  const clock = useRef({ pos: progress.positionMs, at: progress.at, playing, snap: progress });
  const c = clock.current;
  if (c.snap !== progress) Object.assign(c, { pos: progress.positionMs, at: progress.at, snap: progress });
  if (c.playing !== playing) Object.assign(c, { pos: c.pos + (c.playing ? now - c.at : 0), at: now, playing });
  const duration = progress.durationMs;
  const position = Math.max(0, Math.min(duration > 0 ? duration : Infinity, c.pos + (playing ? now - c.at : 0)));

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [playing]);

  // Jump when the handle is let go (or moved with the keyboard), not on every step of the drag.
  const seek = useRef(onSeek);
  seek.current = onSeek;
  useEffect(() => {
    const el = range.current;
    if (!el) return;
    const commit = () => {
      seek.current?.(Number(el.value));
      setDrag(null);
    };
    el.addEventListener('change', commit);
    return () => el.removeEventListener('change', commit);
  }, [silent, status === null]);

  const shown = drag ?? position;
  const seekable = !!onSeek && duration > 0;
  const pct = duration > 0 ? Math.min(100, (shown / duration) * 100) : 0;

  return (
    <div className="player-bar">
      <div className="player-bar-inner">
        {silent ? (
          <p className="hint player-note">{note}</p>
        ) : (
          <>
            <div className={`vinyl tiny ${playing ? 'spinning' : ''}`} aria-hidden>
              ?
            </div>
            <button
              className="primary player-play"
              onClick={onToggle}
              disabled={!canPlay}
              aria-label={playing ? tg.pauseAria : tg.playAria}
              title={playing ? tg.pauseAria : tg.playAria}
            >
              {playing ? '❚❚' : '▶'}
            </button>
            <div className="player-track">
              {status ? (
                <span className="player-status">{status}</span>
              ) : (
                <>
                  <span className="player-time">{time(shown)}</span>
                  <input
                    ref={range}
                    type="range"
                    min={0}
                    max={Math.max(1, Math.round(duration))}
                    step={1000}
                    value={Math.round(shown)}
                    disabled={!seekable}
                    aria-label={tg.seekAria}
                    aria-valuetext={`${time(shown)} / ${time(duration)}`}
                    style={{ ['--pct' as string]: `${pct}%` }}
                    onChange={(e) => setDrag(Number(e.target.value))}
                  />
                  <span className="player-time">{duration > 0 ? time(duration) : '–:––'}</span>
                </>
              )}
            </div>
          </>
        )}
        {onSkip && (
          <button className="ghost player-icon" onClick={onSkip} aria-label={tg.skip} title={tg.skip}>
            ⏭
          </button>
        )}
        {extra}
      </div>
    </div>
  );
}
