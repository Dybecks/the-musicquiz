import { useEffect, useState } from 'react';
import { CLIPS_MS, CLIP_STARS, MAX_BET } from '../game/engine';
import { useT } from '../i18n';

/** The team's bet this turn (mode 'betting'). Without `onSet` it is only shown. */
export function BetPicker({ bet, onSet }: { bet: number; onSet?: (amount: number) => void }) {
  const tm = useT().modes;
  return (
    <section className="turn-extra" aria-label={tm.betTitle}>
      <p className="bonus-label">⭐ {tm.betTitle}</p>
      <div className="bet-options" role="radiogroup" aria-label={tm.betTitle}>
        {Array.from({ length: MAX_BET + 1 }, (_, n) => (
          <button
            key={n}
            role="radio"
            aria-checked={bet === n}
            aria-label={tm.betAria(n)}
            className={`bet ${bet === n ? 'selected' : ''}`}
            disabled={!onSet}
            onClick={() => onSet?.(n)}
          >
            {n}
          </button>
        ))}
      </div>
      <p className="hint">{tm.betHint}</p>
    </section>
  );
}

/** The time left to lock in (mode 'speed'): `deadline` in this device's Date.now(), or null until the song starts. */
export function SpeedClock({ deadline }: { deadline: number | null }) {
  const tm = useT().modes;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [deadline]);
  const left = deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
  return (
    <section className={`turn-extra speed-clock ${left !== null && left <= 10 ? 'urgent' : ''}`}>
      <p className="clock">{left === null ? tm.clockWaits : tm.timeLeft(left)}</p>
      <p className="hint">{tm.fastHint}</p>
    </section>
  );
}

/** How long the intro plays (mode 'intro'), and on the host the buttons to hear it again or longer. */
export function IntroInfo({ clipMs, onReplay, onLonger }: { clipMs: number; onReplay?: () => void; onLonger?: () => void }) {
  const tm = useT().modes;
  const level = Math.max(0, CLIPS_MS.indexOf(clipMs));
  const next = level + 1 < CLIPS_MS.length ? level + 1 : null;
  return (
    <section className="turn-extra">
      <p className="clock">{tm.clipNow(clipMs / 1000, CLIP_STARS[level])}</p>
      {(onReplay || onLonger) && (
        <div className="intro-buttons">
          {onReplay && (
            <button className="ghost" onClick={onReplay}>
              ↺ {tm.replay}
            </button>
          )}
          {onLonger && next !== null && (
            <button className="ghost" onClick={onLonger}>
              {tm.longer(CLIPS_MS[next] / 1000, CLIP_STARS[next])}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
