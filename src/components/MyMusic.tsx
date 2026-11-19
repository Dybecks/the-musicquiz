import { useEffect, useRef, useState } from 'react';
import type { SpotifyProfile } from '../spotify/api';
import { hasScopes } from '../spotify/auth';
import { gatherListening, saveSources, scopesFor, type GatherProgress } from '../spotify/listening';
import {
  ALL_SOURCES,
  SOURCE_LABELS,
  personalSongs,
  summarize,
  type Contributor,
  type ListeningSource,
  type PersonalDeck,
} from '../spotify/personalDeck';

interface Props {
  authChecked: boolean;
  profile: SpotifyProfile | null;
  clientIdField: React.ReactNode;
  hasClientId: boolean;
  personal: PersonalDeck | null;
  sources: ListeningSource[];
  onSourcesChange: (sources: ListeningSource[]) => void;
  /** Set when the user just came back from granting access: build the deck right away. */
  autoGather: boolean;
  onAutoGatherHandled: () => void;
  onLogin: (extraScopes: string[]) => void;
  onBuilt: (contributor: Contributor) => void;
  onForget: () => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function MyMusic(props: Props) {
  const { authChecked, profile, personal, sources, autoGather } = props;
  const [progress, setProgress] = useState<GatherProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const running = useRef(false);

  const needed = scopesFor(sources);
  const granted = !!profile && hasScopes(needed);

  const gather = async () => {
    if (running.current || !profile) return;
    running.current = true;
    setError(null);
    setNotes([]);
    try {
      const result = await gatherListening(sources, setProgress);
      setNotes(result.failures.map((f) => `${SOURCE_LABELS[f.source].title}: ${f.message}`));
      if (result.songs.length === 0) {
        setError('No songs with a release year were found in what you shared.');
        return;
      }
      props.onBuilt({
        userId: profile.id,
        name: profile.display_name || 'You',
        sources,
        builtAt: new Date().toISOString(),
        songs: result.songs,
      });
    } catch (e) {
      setError(message(e));
    } finally {
      running.current = false;
      setProgress(null);
    }
  };

  // Back from Spotify's consent page: build the deck without another click.
  useEffect(() => {
    if (!autoGather || !authChecked) return;
    props.onAutoGatherHandled();
    if (granted) void gather();
    else if (profile) setError("Spotify didn't grant access to your listening, so no deck was built.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoGather, authChecked, granted]);

  const toggle = (source: ListeningSource) => {
    const next = sources.includes(source) ? sources.filter((s) => s !== source) : ALL_SOURCES.filter((s) => s === source || sources.includes(s));
    saveSources(next);
    props.onSourcesChange(next);
  };

  const start = () => {
    if (sources.length === 0) return setError('Choose at least one kind of listening data.');
    if (granted) void gather();
    else props.onLogin(needed);
  };

  const songs = personalSongs(personal);
  const summary = summarize(songs);
  const owner = personal?.contributors[0];
  const busy = progress !== null;
  const biggestDecade = Math.max(1, ...summary.decades.map(([, n]) => n));

  return (
    <div className="spotify-box my-music">
      {owner && !busy && (
        <div className="deck-summary">
          <p>
            <strong>{summary.count} songs</strong> from {owner.name}'s Spotify
            {summary.minYear !== null && (
              <>
                , {summary.minYear}–{summary.maxYear}
              </>
            )}
            .
          </p>
          <ul className="decades" aria-label="Songs per decade">
            {summary.decades.map(([decade, n]) => (
              <li key={decade}>
                <span className="bar" style={{ height: `${Math.max(8, (n / biggestDecade) * 100)}%` }} />
                <span className="n">{n}</span>
                <span className="d">{String(decade).slice(2)}s</span>
              </li>
            ))}
          </ul>
          {summary.decades.length <= 2 && (
            <p className="hint">Most songs are from the same years, which makes the timeline hard. Mixing in the classic deck helps.</p>
          )}
        </div>
      )}

      {busy ? (
        <p className="progress" role="status">
          {progress.step === 'reading'
            ? 'Reading your listening…'
            : progress.step === 'dating'
              ? `Finding the original release year: ${progress.done} of ${progress.total}`
              : `Looking up genres: ${progress.done} of ${progress.total} artists`}
          <progress value={progress.done} max={progress.total || 1} />
        </p>
      ) : (
        <>
          <fieldset className="sources">
            <legend>{owner ? 'Build it again from' : 'Use my'}</legend>
            {ALL_SOURCES.map((source) => (
              <label key={source} className="check">
                <input type="checkbox" checked={sources.includes(source)} onChange={() => toggle(source)} />
                <span>
                  <strong>{SOURCE_LABELS[source].title}</strong>
                  <small>{SOURCE_LABELS[source].detail}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="hint">
            {granted
              ? 'The game reads this from Spotify and keeps the songs in this browser only. Nothing is uploaded or shared.'
              : "Spotify will ask you to allow the game to read this. It's stored in this browser only, nothing is uploaded or shared, and you can delete it here at any time."}
          </p>
          {!profile && authChecked && props.clientIdField}
          <div className="row">
            <button className="spotify" disabled={!authChecked || sources.length === 0 || (!profile && !props.hasClientId)} onClick={start}>
              {granted ? (owner ? 'Rebuild my deck' : 'Build my deck') : 'Allow access and build my deck'}
            </button>
            {owner && (
              <button className="link" onClick={props.onForget}>
                Delete my Spotify songs
              </button>
            )}
          </div>
        </>
      )}
      {notes.map((n) => (
        <p key={n} className="warn">
          Skipped {n}
        </p>
      ))}
      {error && <p className="warn">{error}</p>}
    </div>
  );
}
