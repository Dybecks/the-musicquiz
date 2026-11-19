import { saveSources } from '../spotify/listening';
import {
  ALL_SOURCES,
  SOURCE_LABELS,
  personalSongs,
  summarize,
  type ListeningSource,
  type PersonalDeck,
} from '../spotify/personalDeck';

interface Props {
  personal: PersonalDeck | null;
  sources: ListeningSource[];
  onSourcesChange: (sources: ListeningSource[]) => void;
  /** Whether the songs will be loaded from Spotify when the game starts (instead of reusing the saved ones). */
  willLoad: boolean;
  onForget: () => void;
}

/**
 * Chooses what to read from the host's Spotify. Nothing is read here: the
 * songs are loaded as the last step, after login, using the genres and years
 * chosen on the setup screen.
 */
export function MyMusic({ personal, sources, onSourcesChange, willLoad, onForget }: Props) {
  const toggle = (source: ListeningSource) => {
    const next = sources.includes(source) ? sources.filter((s) => s !== source) : ALL_SOURCES.filter((s) => s === source || sources.includes(s));
    saveSources(next);
    onSourcesChange(next);
  };

  const songs = personalSongs(personal);
  const summary = summarize(songs);
  const owner = personal?.contributors[0];
  const biggestDecade = Math.max(1, ...summary.decades.map(([, n]) => n));

  return (
    <div className="spotify-box my-music">
      <fieldset className="sources">
        <legend>Use my</legend>
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

      {owner && !willLoad ? (
        <div className="deck-summary">
          <p>
            Using the <strong>{summary.count} songs</strong> already loaded from {owner.name}'s Spotify
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
      ) : (
        <p className="hint">
          Your songs are loaded from Spotify when you start, and only those that match the genres and years below are
          kept. Spotify asks you to allow this. The songs stay in this browser only; nothing is uploaded or shared.
        </p>
      )}
      {owner && (
        <button className="link" onClick={onForget}>
          Delete my saved Spotify songs
        </button>
      )}
    </div>
  );
}
