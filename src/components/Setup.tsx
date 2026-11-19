import { useState } from 'react';
import type { SpotifyProfile } from '../spotify/api';
import { getClientId, redirectUri, setClientId } from '../spotify/auth';
import type { PlaybackKind } from '../spotify/playback';
import { DECKS, chooseSongs, deckSongs, normalizeDecks, parseSavedDecks, playableSongs, type DeckId } from '../data/decks';
import { loadSources } from '../spotify/listening';
import { personalSongs, type Contributor, type ListeningSource, type PersonalDeck } from '../spotify/personalDeck';
import { MyMusic } from './MyMusic';

export interface SetupValues {
  players: string[];
  targetCards: number;
  mode: PlaybackKind;
  decks: DeckId[];
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

function loadDecks(): DeckId[] {
  return parseSavedDecks(localStorage.getItem(DECK_KEY));
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
  const [clientId, setClientIdState] = useState(getClientId);
  const [error, setError] = useState<string | null>(null);
  const [decks, setDecks] = useState<DeckId[]>(loadDecks);
  const [sources, setSources] = useState<ListeningSource[]>(loadSources);

  const isPremium = profile?.product === 'premium';
  // Only the Premium option requires a login. The hidden player works without
  // one, using the songs that have a known Spotify id.
  const needsLogin = mode === 'premium' && !profile;
  const mySongs = personalSongs(personal).length;
  const wantsMine = decks.includes('mine');
  const needsPersonal = wantsMine && mySongs === 0;
  const songCount = chooseSongs({ decks, mode, loggedIn: !!profile, personal }).length;
  const names = players.map((p) => p.trim()).filter(Boolean);

  const toggleDeck = (id: DeckId) => {
    const next = decks.includes(id) ? decks.filter((d) => d !== id) : normalizeDecks([...decks, id]);
    if (next.length === 0) return; // keep at least one deck
    setDecks(next);
    localStorage.setItem(DECK_KEY, JSON.stringify(next));
  };

  const deckDetail = (id: DeckId, detail: string) => {
    const all = deckSongs(id, personal).length;
    if (id === 'mine') return mySongs ? `${mySongs} songs from what you listen to.` : detail;
    const playable = playableSongs(deckSongs(id, personal), mode, !!profile).length;
    if (playable === all) return `${all} songs. ${detail}`;
    if (playable === 0) return `${all} songs. ${detail} Needs a Spotify login to play.`;
    return `${playable} of ${all} songs play without a login. ${detail}`;
  };

  const clientIdField = (
    <>
      <label className="field">
        <span>Spotify Client ID</span>
        <input
          value={clientId}
          placeholder="From developer.spotify.com/dashboard"
          onChange={(e) => {
            setClientIdState(e.target.value);
            setClientId(e.target.value);
          }}
        />
      </label>
      <p className="hint">
        Add <code>{redirectUri()}</code> as a Redirect URI in your Spotify app settings.
      </p>
    </>
  );

  const start = () => {
    if (names.length === 0) return setError('Add at least one player or team.');
    if (needsPersonal) return setError('Build your deck from Spotify first, or untick My Spotify music.');
    if (songCount === 0) return setError('These songs need a Spotify login to play. Log in, or choose other decks.');
    if (songCount < names.length + 1) return setError('There are too few songs for this many players.');
    if (needsLogin) return setError('Log in with Spotify first, or choose the hidden Spotify player.');
    localStorage.setItem(PLAYERS_KEY, JSON.stringify(names));
    localStorage.setItem(TARGET_KEY, String(target));
    onStart({ players: names, targetCards: target, mode, decks });
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
          {needsPersonal
            ? 'Build your deck from Spotify below to see how many songs you get.'
            : `You'll play with ${songCount} songs.`}
        </p>
      </section>

      <section className="panel">
        <h2>Which songs?</h2>
        <p className="hint">Pick one or more. Songs from several decks are shuffled together.</p>
        <div className="mode-options deck-options" role="group" aria-label="Which songs?">
          {DECKS.map((d) => (
            <DeckOption key={d.id} title={d.title} detail={deckDetail(d.id, d.detail)} checked={decks.includes(d.id)} onToggle={() => toggleDeck(d.id)} />
          ))}
        </div>
        {wantsMine && (
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
        {wantsMine && authMessage && mode !== 'premium' && <p className="warn">{authMessage}</p>}
      </section>

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
            detail={`A covered-up Spotify player. Full songs if this browser is signed in to Spotify, otherwise 30-second previews. Without a login it plays only songs with a known Spotify id (${deckSize.noLogin} of the classic hits, and your own Spotify songs).`}
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
        {mode === 'embed' && profile && (
          <p className="hint spotify-box">You're logged in, so the hidden player can use every song in the chosen decks.</p>
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

function DeckOption(props: { title: string; detail: string; checked: boolean; onToggle: () => void }) {
  return (
    <button role="checkbox" aria-checked={props.checked} className={`mode deck ${props.checked ? 'selected' : ''}`} onClick={props.onToggle}>
      <span className="tick" aria-hidden="true">
        {props.checked ? '✓' : ''}
      </span>
      <strong>{props.title}</strong>
      <span>{props.detail}</span>
    </button>
  );
}
