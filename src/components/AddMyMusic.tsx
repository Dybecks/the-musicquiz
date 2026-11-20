import { useEffect, useState } from 'react';
import type { Song } from '../game/engine';
import type { SpotifyProfile } from '../spotify/api';
import { hasScopes, isLoggedIn, login, logout } from '../spotify/auth';
import {
  PLAYLIST_SCOPES,
  fetchPlaylists,
  newPlaylistPlan,
  startList,
  type BuildProgress,
  type PlaylistSummary,
  type RefillPlan,
} from '../spotify/listening';
import { msg, useT } from '../i18n';
import { Rich } from '../i18n/Rich';

/** Songs sent per tap: a few batches from the chosen playlists. */
const SEND_AT_ONCE = 40;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Props {
  profile: SpotifyProfile | null;
  /** Sends the songs to the host. */
  onSend: (songs: Song[]) => void;
  /** What the host said it added, or null while nothing was sent. */
  added: number | null;
}

/**
 * Optional, on a joined phone or computer: log in to Spotify and send songs
 * from your own playlists into the game. Nothing here is needed to play.
 */
export function AddMyMusic({ profile, onSend, added }: Props) {
  const tt = useT();
  const t = tt.addMusic;
  const loggedIn = !!profile && isLoggedIn();
  const canRead = loggedIn && hasScopes(PLAYLIST_SCOPES);
  const [open, setOpen] = useState(canRead);
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<RefillPlan | null>(null);
  const [progress, setProgress] = useState<BuildProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(0);

  useEffect(() => {
    if (!open || !canRead || playlists) return;
    fetchPlaylists()
      .then(({ playlists: p }) => setPlaylists(p.filter((x) => x.tracks > 0)))
      .catch((e) => setError(message(e)));
  }, [open, canRead, playlists]);

  if (!open) {
    return (
      <section className="panel add-music">
        <h2>
          {t.title} <span className="muted">{t.optional}</span>
        </h2>
        <p className="hint">{t.intro}</p>
        <button className="ghost" onClick={() => setOpen(true)}>
          {t.open}
        </button>
      </section>
    );
  }

  const close = (
    <button className="link" onClick={() => setOpen(false)}>
      {t.notNow}
    </button>
  );

  if (!canRead) {
    return (
      <section className="panel add-music">
        <h2>{t.heading}</h2>
        <p className="hint">{t.loginHint}</p>
        {error && <p className="warn">{error}</p>}
        <div className="row-actions">
          <button
            className="spotify"
            onClick={() => login({ extraScopes: PLAYLIST_SCOPES, afterLogin: 'contribute' }).catch((e) => setError(message(e)))}
          >
            {t.login}
          </button>
          {close}
        </div>
      </section>
    );
  }

  const send = async () => {
    setError(null);
    try {
      const start = plan ?? newPlaylistPlan((playlists ?? []).filter((p) => chosen.has(p.id)));
      const { songs, plan: next } = await startList(start, setProgress, SEND_AT_ONCE);
      setPlan(next);
      setProgress(null);
      if (songs.length === 0) return setError(msg().addMusic.noYear);
      onSend(songs);
      setSent((n) => n + songs.length);
    } catch (e) {
      setProgress(null);
      setError(message(e));
    }
  };

  return (
    <section className="panel add-music">
      <h2>{t.heading}</h2>
      <p className="hint">
        <Rich text={tt.setup.loggedInAs(profile?.display_name ?? '')} />{' '}
        <button
          className="link"
          onClick={() => {
            logout();
            setOpen(false);
            setPlaylists(null);
          }}
        >
          {tt.setup.logOut}
        </button>
      </p>
      {!plan && (
        <>
          {!playlists && !error && <p className="hint">{t.reading}</p>}
          {playlists && playlists.length === 0 && <p className="hint">{t.noPlaylists}</p>}
          {playlists && playlists.length > 0 && (
            <div className="sources pick-playlists">
              {playlists.map((p) => (
                <label key={p.id} className="check">
                  <input
                    type="checkbox"
                    checked={chosen.has(p.id)}
                    onChange={() => {
                      const next = new Set(chosen);
                      if (next.has(p.id)) next.delete(p.id);
                      else next.add(p.id);
                      setChosen(next);
                    }}
                  />
                  <span>
                    {p.name}
                    <small>{t.songs(p.tracks)}</small>
                  </span>
                </label>
              ))}
            </div>
          )}
        </>
      )}
      {progress && (
        <div className="progress">
          <span>{progress.label}…</span>
          <progress max={progress.total} value={progress.done} />
        </div>
      )}
      {added !== null && sent > 0 && (
        <p className="info">
          {added > 0 ? t.added(added) : t.alreadyIn}
        </p>
      )}
      {error && <p className="warn">{error}</p>}
      <div className="row-actions">
        <button className="primary" disabled={!!progress || (!plan && chosen.size === 0)} onClick={send}>
          {plan ? t.sendMore : chosen.size ? t.sendFrom(chosen.size) : t.pickPlaylists}
        </button>
        {plan && (
          <button className="link" onClick={() => setPlan(null)}>
            {t.pickOther}
          </button>
        )}
        {close}
      </div>
    </section>
  );
}
