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
        <h2>Add your own music? <span className="muted">(optional)</span></h2>
        <p className="hint">
          Log in to Spotify to put songs from your playlists into the game. You can play without it.
        </p>
        <button className="ghost" onClick={() => setOpen(true)}>
          Add songs from my Spotify
        </button>
      </section>
    );
  }

  const close = (
    <button className="link" onClick={() => setOpen(false)}>
      Not now
    </button>
  );

  if (!canRead) {
    return (
      <section className="panel add-music">
        <h2>Add songs from your Spotify</h2>
        <p className="hint">
          You’ll come straight back here after logging in. Only your playlists are read, and the songs go to this game
          only. While the game’s Spotify app is in development mode, your account must be added to it by the person
          who runs it.
        </p>
        {error && <p className="warn">{error}</p>}
        <div className="row-actions">
          <button
            className="spotify"
            onClick={() => login({ extraScopes: PLAYLIST_SCOPES, afterLogin: 'contribute' }).catch((e) => setError(message(e)))}
          >
            Log in with Spotify
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
      if (songs.length === 0) return setError('No songs with a release year were found in those playlists.');
      onSend(songs);
      setSent((n) => n + songs.length);
    } catch (e) {
      setProgress(null);
      setError(message(e));
    }
  };

  return (
    <section className="panel add-music">
      <h2>Add songs from your Spotify</h2>
      <p className="hint">
        Logged in as <strong>{profile?.display_name}</strong>.{' '}
        <button
          className="link"
          onClick={() => {
            logout();
            setOpen(false);
            setPlaylists(null);
          }}
        >
          Log out
        </button>
      </p>
      {!plan && (
        <>
          {!playlists && !error && <p className="hint">Reading your playlists…</p>}
          {playlists && playlists.length === 0 && <p className="hint">No playlists with songs were found.</p>}
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
                    <small>{p.tracks} songs</small>
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
          {added > 0 ? `${added} new songs were added to the game.` : 'Those songs were already in the game.'}
        </p>
      )}
      {error && <p className="warn">{error}</p>}
      <div className="row-actions">
        <button className="primary" disabled={!!progress || (!plan && chosen.size === 0)} onClick={send}>
          {plan ? 'Send more songs' : chosen.size ? `Send songs from ${chosen.size} playlist${chosen.size > 1 ? 's' : ''}` : 'Pick playlists'}
        </button>
        {plan && (
          <button className="link" onClick={() => setPlan(null)}>
            Pick other playlists
          </button>
        )}
        {close}
      </div>
    </section>
  );
}
