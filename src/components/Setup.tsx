import { useState } from 'react';
import type { SpotifyProfile } from '../spotify/api';
import { BUILT_IN_CLIENT_ID, getClientIdOverride, redirectUri, setClientId } from '../spotify/auth';
import type { PlaybackKind } from '../spotify/playback';
import { chooseSongs, classicSongs, type DeckChoice } from '../data/decks';
import { loadSources } from '../spotify/listening';
import { personalSongs, type Contributor, type ListeningSource, type PersonalDeck } from '../spotify/personalDeck';
import { MyMusic } from './MyMusic';
import { DeckFilterPanel } from './DeckFilterPanel';
import { loadFilter, personalPresets, saveFilter, STANDARD_PRESETS, type DeckFilter } from '../data/genres';

export interface SetupValues {
  players: string[];
  targetCards: number;
  mode: PlaybackKind;
  deck: DeckChoice;
  filter: DeckFilter;
}

interface Props {
  authChecked: boolean;
  profile: SpotifyProfile | null;
  authMessage: string | null;
  initialMode: PlaybackKind;
  deckSize: { all: number; noLogin: number };
  personal: PersonalDeck | null;
  autoGather: boolean;
  onAutoGatherHandled: () => void;
  onLogin: (extraScopes?: string[]) => void;
  onLogout: () => void;
  onPersonalBuilt: (contributor: Contributor) => void;
  onPersonalForget: () => void;
  onStart: (values: SetupValues) => void;
}

const PLAYERS_KEY = 'mq.players';
const TARGET_KEY = 'mq.target';
const DECK_KEY = 'mq.deck';

function loadDeckChoice(): DeckChoice {
  const saved = localStorage.getItem(DECK_KEY);
  return saved === 'mine' || saved === 'mix' ? saved : 'classic';
}

function loadPlayers(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYERS_KEY) ?? 'null');
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {
    /* ignore */
  }
  return ['Team 1', 'Team 2'];
}

export function Setup(props: Props) {
  const { authChecked, profile, authMessage, initialMode, deckSize, personal, onLogin, onLogout, onStart } = props;
  const [players, setPlayers] = useState<string[]>(loadPlayers);
  const [target, setTarget] = useState<number>(() => Number(localStorage.getItem(TARGET_KEY)) || 10);
  const [mode, setMode] = useState<PlaybackKind>(initialMode);
  const [clientIdOverride, setClientIdOverride] = useState(getClientIdOverride);
  const clientId = clientIdOverride.trim() || BUILT_IN_CLIENT_ID;
  const [error, setError] = useState<string | null>(null);
  const [deck, setDeck] = useState<DeckChoice>(loadDeckChoice);
  const [sources, setSources] = useState<ListeningSource[]>(loadSources);
  const [filter, setFilterState] = useState<DeckFilter>(loadFilter);
  const setFilter = (f: DeckFilter) => {
    setFilterState(f);
    saveFilter(f);
  };

  const isPremium = profile?.product === 'premium';
  // Only the Premium option requires a login. The hidden player works without
  // one, using the songs that have a known Spotify id.
  const needsLogin = mode === 'premium' && !profile;
  const mySongs = personalSongs(personal).length;
  const needsPersonal = deck !== 'classic' && mySongs === 0;
  const deckOptions = { choice: deck, mode, loggedIn: !!profile, personal };
  const unfilteredCount = needsPersonal ? 0 : chooseSongs(deckOptions).length;
  const songCount = needsPersonal ? 0 : chooseSongs({ ...deckOptions, filter }).length;
  const myPresets = personalPresets(personalSongs(personal));
  const classicCount = classicSongs(mode, !!profile).length;
  const names = players.map((p) => p.trim()).filter(Boolean);

  const chooseDeck = (choice: DeckChoice) => {
    setDeck(choice);
    localStorage.setItem(DECK_KEY, choice);
  };

  // The game ships with its own Spotify app, so the Client ID field is tucked
  // away for hosts who want to use their own app instead.
  const clientIdInput = (
    <>
      <label className="field">
        <span>Spotify Client ID{BUILT_IN_CLIENT_ID ? ' (leave empty to use the game’s own)' : ''}</span>
        <input
          value={clientIdOverride}
          placeholder="From developer.spotify.com/dashboard"
          onChange={(e) => {
            setClientIdOverride(e.target.value);
            setClientId(e.target.value);
          }}
        />
      </label>
      <p className="hint">
        Add <code>{redirectUri()}</code> as a Redirect URI in your Spotify app settings.
      </p>
    </>
  );
  const clientIdField = BUILT_IN_CLIENT_ID ? (
    <details className="own-app" open={!!clientIdOverride}>
      <summary>Use your own Spotify app</summary>
      {clientIdInput}
    </details>
  ) : (
    clientIdInput
  );

  const start = () => {
    if (names.length === 0) return setError('Add at least one player or team.');
    if (needsPersonal) return setError('Build your deck from Spotify first, or choose the classic deck.');
    if (songCount < names.length + 1) return setError('Too few songs match. Widen the genres or years, or use fewer players.');
    if (needsLogin) return setError('Log in with Spotify first, or choose the hidden Spotify player.');
    localStorage.setItem(PLAYERS_KEY, JSON.stringify(names));
    localStorage.setItem(TARGET_KEY, String(target));
    onStart({ players: names, targetCards: target, mode, deck, filter });
  };

  return (
    <main className="setup">
      <section className="panel intro">
        <h1>Place the song on your timeline</h1>
        <p>
          A mystery song plays. Decide whether it came out before, after or between the years on your timeline.
          Get it right and the card is yours. The first to collect <strong>{target}</strong> cards wins.
        </p>
      </section>

      <section className="panel">
        <h2>Players or teams</h2>
        <ul className="player-list">
          {players.map((name, i) => (
            <li key={i}>
              <input
                aria-label={`Player ${i + 1} name`}
                value={name}
                maxLength={24}
                onChange={(e) => setPlayers(players.map((p, j) => (j === i ? e.target.value : p)))}
              />
              {players.length > 1 && (
                <button className="ghost" aria-label={`Remove ${name || 'player'}`} onClick={() => setPlayers(players.filter((_, j) => j !== i))}>
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
        {players.length < 8 && (
          <button className="ghost add" onClick={() => setPlayers([...players, `Team ${players.length + 1}`])}>
            + Add player or team
          </button>
        )}

        <label className="field">
          <span>Cards needed to win</span>
          <input type="number" min={3} max={30} value={target} onChange={(e) => setTarget(Math.max(3, Math.min(30, Number(e.target.value) || 10)))} />
        </label>
        <p className="hint">
          {needsPersonal ? 'Build your deck from Spotify below to see how many songs you get.' : `You'll play with ${songCount} songs.`}
        </p>
      </section>

      <section className="panel">
        <h2>Which songs?</h2>
        <div className="mode-options" role="radiogroup" aria-label="Which songs?">
          <ModeOption
            value="classic"
            current={deck}
            onSelect={chooseDeck}
            title="Classic deck"
            detail={`${classicCount} well-known songs from the 1950s to today.`}
          />
          <ModeOption
            value="mine"
            current={deck}
            onSelect={chooseDeck}
            title="My Spotify music"
            detail={mySongs ? `${mySongs} songs from what you listen to.` : 'Songs you actually listen to, from your Spotify account.'}
          />
          <ModeOption
            value="mix"
            current={deck}
            onSelect={chooseDeck}
            title="Mix of both"
            detail="Your songs plus the classic deck, for a wider spread of years."
          />
        </div>
        {deck !== 'classic' && (
          <MyMusic
            authChecked={authChecked}
            profile={profile}
            clientIdField={clientIdField}
            hasClientId={!!clientId.trim()}
            personal={personal}
            sources={sources}
            onSourcesChange={setSources}
            autoGather={props.autoGather}
            onAutoGatherHandled={props.onAutoGatherHandled}
            onLogin={(scopes) => onLogin(scopes)}
            onBuilt={props.onPersonalBuilt}
            onForget={props.onPersonalForget}
          />
        )}
        {deck !== 'classic' && authMessage && mode !== 'premium' && <p className="warn">{authMessage}</p>}
      </section>

      <DeckFilterPanel
        filter={filter}
        onChange={setFilter}
        presets={STANDARD_PRESETS}
        personalPresets={myPresets}
        hasPersonal={mySongs > 0}
        count={songCount}
        total={unfilteredCount}
      />

      <section className="panel">
        <h2>How should the music play?</h2>
        <div className="mode-options" role="radiogroup" aria-label="How should the music play?">
          <ModeOption
            value="premium"
            current={mode}
            onSelect={setMode}
            title="Log in with Spotify"
            detail="Full songs played right here. Needs Spotify Premium."
          />
          <ModeOption
            value="embed"
            current={mode}
            onSelect={setMode}
            title="Hidden Spotify player, no login"
            detail={`A covered-up Spotify player. Full songs if this browser is signed in to Spotify, otherwise 30-second previews.${deck === 'classic' ? ` Plays ${deckSize.noLogin} of the classic songs without a login.` : ''}`}
          />
          <ModeOption value="none" current={mode} onSelect={setMode} title="No audio" detail="Try the rules, or play the music some other way." />
        </div>

        {mode === 'premium' && (
          <div className="spotify-box">
            {!authChecked ? (
              <p className="hint">Checking Spotify login…</p>
            ) : profile ? (
              <p>
                Logged in as <strong>{profile.display_name}</strong> ({isPremium ? 'Premium' : profile.product}).{' '}
                <button className="link" onClick={onLogout}>
                  Log out
                </button>
              </p>
            ) : (
              <>
                {clientIdField}
                <button className="spotify" disabled={!clientId.trim()} onClick={() => onLogin()}>
                  Log in with Spotify
                </button>
              </>
            )}
            {profile && !isPremium && (
              <p className="warn">This account isn't Premium, so in-browser playback won't work. Choose the hidden Spotify player instead.</p>
            )}
            {authMessage && <p className="warn">{authMessage}</p>}
          </div>
        )}
        {mode === 'embed' && profile && deck === 'classic' && (
          <p className="hint spotify-box">You're logged in, so the hidden player can use all {deckSize.all} songs.</p>
        )}
      </section>

      {error && <p className="warn center">{error}</p>}
      <button className="primary big" onClick={start}>
        Start game
      </button>
    </main>
  );
}

function ModeOption<T extends string>(props: { value: T; current: T; onSelect: (v: T) => void; title: string; detail: string }) {
  const selected = props.value === props.current;
  return (
    <button role="radio" aria-checked={selected} className={`mode ${selected ? 'selected' : ''}`} onClick={() => props.onSelect(props.value)}>
      <strong>{props.title}</strong>
      <span>{props.detail}</span>
    </button>
  );
}
