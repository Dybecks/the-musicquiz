import { useEffect, useState } from 'react';
import { clearSpotifyLog, getDevices, getPlaybackState, onSpotifyLog, spotifyLog } from '../spotify/api';
import { locale, useT } from '../i18n';

/**
 * Spotify's own answers to the game's player commands (/me/player…), to see
 * why a speaker won't play: which device is active, whether Spotify marks it
 * restricted, and what it said to each play and pause. Logging costs no
 * requests; "Ask Spotify now" costs two.
 */
export function SpotifyLog() {
  const t = useT().spotifyLog;
  const [, redraw] = useState(0);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => onSpotifyLog(() => redraw((n) => n + 1)), []);

  const entries = spotifyLog();
  const text = entries
    .map((e) => {
      const time = new Date(e.at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const head = `${time}  ${e.method} ${e.path}  → ${e.status || t.noAnswer}`;
      return [head, e.sent && `  ${t.sent}: ${e.sent}`, e.body && `  ${pretty(e.body)}`].filter(Boolean).join('\n');
    })
    .join('\n\n');

  const check = async () => {
    setChecking(true);
    // Errors are in the log too, so there is nothing more to show here.
    await getPlaybackState().catch(() => {});
    await getDevices().catch(() => {});
    setChecking(false);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the text can still be selected by hand */
    }
  };

  return (
    <details className="spotify-log">
      <summary>{t.title}</summary>
      <p className="hint">{t.hint}</p>
      <p>
        <button className="link" onClick={() => void check()} disabled={checking}>
          {checking ? t.checking : t.check}
        </button>{' '}
        ·{' '}
        <button className="link" onClick={() => void copy()} disabled={!entries.length}>
          {copied ? t.copied : t.copy}
        </button>{' '}
        ·{' '}
        <button className="link" onClick={clearSpotifyLog} disabled={!entries.length}>
          {t.clear}
        </button>
      </p>
      {entries.length ? <pre>{text}</pre> : <p className="hint">{t.empty}</p>}
    </details>
  );
}

/** JSON indented, so is_active and is_restricted are easy to find. */
function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2).replace(/\n/g, '\n  ');
  } catch {
    return body;
  }
}
