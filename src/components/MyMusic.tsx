import { saveSources } from '../spotify/listening';
import {
  ALL_SOURCES,
  SOURCE_LABELS,
  friendContributors,
  hostContributor,
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
  onForgetMine: () => void;
  canAddFriend: boolean;
  onAddFriend: () => void;
  onRemoveFriend: (userId: string) => void;
}

/**
 * Chooses what to read from the host's Spotify. Nothing is read here: the
 * songs are loaded as the last step, after login, using the genres and years
 * chosen on the setup screen.
 */
export function MyMusic(props: Props) {
  const { personal, sources, onSourcesChange, willLoad } = props;
  const toggle = (source: ListeningSource) => {
    const next = sources.includes(source) ? sources.filter((s) => s !== source) : ALL_SOURCES.filter((s) => s === source || sources.includes(s));
    saveSources(next);
    onSourcesChange(next);
  };

  const owner = hostContributor(personal);
  const friends = friendContributors(personal);
  const summary = summarize(owner?.songs ?? []);
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
          Your songs are loaded from Spotify when you start, and only those that fit the genres and years above are
          kept. Spotify asks you to allow this. The songs stay in this browser only; nothing is uploaded or shared.
        </p>
      )}
      {owner && (
        <button className="link" onClick={props.onForgetMine}>
          Delete my saved Spotify songs
        </button>
      )}

      <div className="friends">
        <h3>Friends’ music</h3>
        {friends.length > 0 && (
          <ul className="friend-list">
            {friends.map((f) => (
              <li key={f.userId}>
                <span>
                  <strong>{f.name}</strong> <span className="muted">{f.songs.length} songs</span>
                </span>
                <button className="ghost" aria-label={`Remove ${f.name}'s music`} onClick={() => props.onRemoveFriend(f.userId)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="hint">
          Mix in what the others listen to. Each friend logs in to Spotify on this device (on Spotify’s page, “Not you?”
          switches account); only their songs that fit the genres and years chosen above are loaded, and then your own login
          comes back. Spotify only lets an account log in if it is added as a user of the game’s Spotify app while the
          app is in development mode.
        </p>
        <button className="ghost add" disabled={!props.canAddFriend} onClick={props.onAddFriend}>
          + Add a friend’s Spotify music
        </button>
      </div>
    </div>
  );
}
