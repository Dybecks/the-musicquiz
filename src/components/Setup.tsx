import { useEffect, useRef, useState } from 'react';
import type { SpotifyProfile } from '../spotify/api';
import { BUILT_IN_CLIENT_ID, getClientIdOverride, hasScopes, redirectUri, setClientId } from '../spotify/auth';
import type { PlaybackKind } from '../spotify/playback';
import { DECKS, chooseSongs, deckSongs, normalizeDecks, parseSavedDecks, playableSongs, type DeckId } from '../data/decks';
import { gatherListening, loadSources, scopesFor, type GatherProgress } from '../spotify/listening';
import {
  SOURCE_LABELS,
  personalSongs,
  type Contributor,
  type ListeningSource,
  type PersonalDeck,
} from '../spotify/personalDeck';
import { MyMusic } from './MyMusic';
import { DeckFilterPanel } from './DeckFilterPanel';
import { loadFilter, NO_FILTER, personalPresets, sameFilter, saveFilter, STANDARD_PRESETS, type DeckFilter } from '../data/genres';

export interface SetupValues {
  players: string[];
  targetCards: number;
  mode: PlaybackKind;
  decks: DeckId[];
  filter: DeckFilter;
  /** The host's own songs to play with, freshly loaded or saved earlier. */
  personal: PersonalDeck | null;
  /** Whether the game may use the Spotify login (search, Premium playback). */
  loggedIn: boolean;
}

interface Props {
  profile: SpotifyProfile | null;
  authMessage: string | null;
  initialMode: PlaybackKind;
  onModeChange: (mode: PlaybackKind) => void;
  deckSize: { all: number; noLogin: number };
  personal: PersonalDeck | null;
  /** Set when the host just came back from logging in: load the music and start right away. */
  autoStart: boolean;
  onAutoStartHandled: () => void;
  onLogin: (extraScopes: string[]) => void;
  onLogout: () => void;
  onPersonalBuilt: (contributor: Contributor) => PersonalDeck;
  onPersonalForget: () => void;
  onStart: (values: SetupValues) => void;
}

/** Whether the host plays with a Spotify login. The login itself happens last. */
type Account = 'login' | 'guest';
type Step = 'account' | 'music' | 'loading';

const PLAYERS_KEY = 'mq.players';
const TARGET_KEY = 'mq.target';
const DECK_KEY = 'mq.deck';
const ACCOUNT_KEY = 'mq.account';

function loadAccount(): Account | null {
  const saved = localStorage.getItem(ACCOUNT_KEY);
  return saved === 'login' || saved === 'guest' ? saved : null;
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

const sameSources = (a: readonly ListeningSource[], b: readonly ListeningSource[]) =>
  a.length === b.length && a.every((s) => b.includes(s));

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Setup(props: Props) {
  const { profile, authMessage, deckSize, personal, onLogout } = props;
  const [account, setAccountState] = useState<Account | null>(loadAccount);
  const [step, setStep] = useState<Step>(() => ((props.autoStart || authMessage) && loadAccount() === 'login' ? 'music' : 'account'));
  const [players, setPlayers] = useState<string[]>(loadPlayers);
  const [target, setTarget] = useState<number>(() => Number(localStorage.getItem(TARGET_KEY)) || 10);
  const [mode, setModeState] = useState<PlaybackKind>(props.initialMode);
  const [clientIdOverride, setClientIdOverride] = useState(getClientIdOverride);
  const clientId = clientIdOverride.trim() || BUILT_IN_CLIENT_ID;
  const [error, setError] = useState<string | null>(null);
  const [decks, setDecks] = useState<DeckId[]>(() => parseSavedDecks(localStorage.getItem(DECK_KEY)));
  const [sources, setSources] = useState<ListeningSource[]>(loadSources);
  const [filter, setFilterState] = useState<DeckFilter>(loadFilter);
  const [progress, setProgress] = useState<GatherProgress | null>(null);
  const running = useRef(false);

  // Everything chosen here is kept in the browser, so it survives the trip
  // to Spotify's login page and back.
  useEffect(() => localStorage.setItem(PLAYERS_KEY, JSON.stringify(players)), [players]);
  useEffect(() => localStorage.setItem(TARGET_KEY, String(target)), [target]);

  const setAccount = (a: Account) => {
    setAccountState(a);
    localStorage.setItem(ACCOUNT_KEY, a);
  };
  const setMode = (m: PlaybackKind) => {
    setModeState(m);
    props.onModeChange(m);
  };
  const setFilter = (f: DeckFilter) => {
    setFilterState(f);
    saveFilter(f);
  };

  const useLogin = account === 'login';
  const loggedIn = useLogin && !!profile;
  const owner = personal?.contributors[0];
  const mySavedSongs = personalSongs(personal).length;
  // Without a login, the songs saved from an earlier login can still be used.
  const visibleDecks = DECKS.filter((d) => d.id !== 'mine' || useLogin || mySavedSongs > 0);
  const activeDecks = normalizeDecks(decks.filter((d) => visibleDecks.some((v) => v.id === d)));
  const wantsMine = activeDecks.includes('mine');
  // Playing in the browser needs a login; without one, use the hidden player.
  const playMode: PlaybackKind = !useLogin && mode === 'premium' ? 'embed' : mode;

  // The saved songs are reused only if they were loaded for the same choices.
  const canReuse = (p: SpotifyProfile | null) =>
    !!owner &&
    (!p || owner.userId === p.id) &&
    sameSources(owner.sources, sources) &&
    sameFilter(owner.filter ?? NO_FILTER, filter);
  const willLoad = useLogin && wantsMine && !canReuse(profile);

  const deckOptions = { decks: activeDecks, mode: playMode, loggedIn: useLogin, personal: willLoad ? null : personal };
  const unfilteredCount = chooseSongs(deckOptions).length;
  const songCount = chooseSongs({ ...deckOptions, filter }).length;
  const myPresets = personalPresets(personalSongs(personal));
  const soundtrackWithGenres = filter.genres.length > 0 && activeDecks.some((d) => d !== 'classic' && d !== 'mine');
  const names = players.map((p) => p.trim()).filter(Boolean);

  const toggleDeck = (id: DeckId) => {
    const next = activeDecks.includes(id) ? activeDecks.filter((d) => d !== id) : normalizeDecks([...activeDecks, id]);
    if (next.length === 0) return; // keep at least one deck
    setDecks(next);
    localStorage.setItem(DECK_KEY, JSON.stringify(next));
  };

  const deckDetail = (id: DeckId, detail: string) => {
    if (id === 'mine') {
      if (willLoad) return 'Loaded from your Spotify when you start, matching the genres and years you choose.';
      return mySavedSongs ? `${mySavedSongs} songs from what you listen to.` : detail;
    }
    const all = deckSongs(id, personal).length;
    const playable = playableSongs(deckSongs(id, personal), playMode, useLogin).length;
    if (playable === all) return `${all} songs. ${detail}`;
    if (playable === 0) return `${all} songs. ${detail} Needs a Spotify login to play.`;
    return `${playable} of ${all} songs play without a login. ${detail}`;
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

  const values = (personalDeck: PersonalDeck | null): SetupValues => ({
    players: names,
    targetCards: target,
    mode: playMode,
    decks: activeDecks,
    filter,
    personal: personalDeck,
    loggedIn,
  });

  /** Checks what can be checked before the host's own songs are loaded. */
  const validate = (): string | null => {
    if (names.length === 0) return 'Add at least one player or team.';
    if (sources.length === 0 && willLoad) return 'Choose at least one kind of Spotify listening, or untick My Spotify music.';
    if (willLoad) return null; // the count is checked once the songs are loaded
    if (unfilteredCount === 0)
      return useLogin ? 'These decks have no songs to play. Choose other decks.' : 'These songs need a Spotify login to play. Go back and choose to log in, or pick other decks.';
    if (songCount < names.length + 1) return 'Too few songs match. Widen the genres or years, or use fewer players.';
    return null;
  };

  /** The last step for a logged-in host: load the songs that match the choices, then start. */
  const loadAndStart = async (p: SpotifyProfile) => {
    if (running.current) return;
    if (playMode === 'premium' && p.product !== 'premium') {
      setError("This account isn't Premium, so music can't play in the browser. Choose the hidden Spotify player instead.");
      return;
    }
    let deck = personal;
    if (wantsMine && !canReuse(p)) {
      running.current = true;
      setStep('loading');
      try {
        const result = await gatherListening(sources, filter, setProgress);
        const skipped = result.failures.map((f) => `${SOURCE_LABELS[f.source].title}: ${f.message}`);
        if (result.songs.length === 0) {
          setError(
            ['None of your Spotify songs match these genres and years. Widen them, or untick My Spotify music.', ...skipped.map((s) => `Skipped ${s}`)].join(' '),
          );
          setStep('music');
          return;
        }
        deck = props.onPersonalBuilt({
          userId: p.id,
          name: p.display_name || 'You',
          sources,
          filter,
          builtAt: new Date().toISOString(),
          songs: result.songs,
        });
      } catch (e) {
        setError(message(e));
        setStep('music');
        return;
      } finally {
        running.current = false;
        setProgress(null);
      }
    }
    const count = chooseSongs({ decks: activeDecks, mode: playMode, loggedIn: true, personal: deck, filter }).length;
    if (count < names.length + 1) {
      setError('Too few songs match. Widen the genres or years, add a deck, or use fewer players.');
      setStep('music');
      return;
    }
    props.onStart(values(deck));
  };

  const start = () => {
    setError(null);
    const problem = validate();
    if (problem) return setError(problem);
    if (!useLogin) return props.onStart(values(personal));
    const needed = willLoad ? scopesFor(sources) : [];
    // Log in (or ask for more access) last; the game starts on the way back.
    if (!profile || !hasScopes(needed)) return props.onLogin(needed);
    void loadAndStart(profile);
  };

  // Back from Spotify's login page: carry on where the host left off.
  useEffect(() => {
    if (!props.autoStart) return;
    props.onAutoStartHandled();
    if (!useLogin) return;
    setStep('music');
    if (!profile) return;
    if (!hasScopes(willLoad ? scopesFor(sources) : [])) {
      setError("Spotify didn't grant access to your listening, so your songs couldn't be loaded.");
      return;
    }
    const problem = validate();
    if (problem) return setError(problem);
    void loadAndStart(profile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.autoStart]);

  const steps = ['Spotify', 'Music', useLogin ? 'Log in & load' : 'Play'];
  const stepIndex = step === 'account' ? 0 : step === 'music' ? 1 : 2;
  const stepBar = (
    <ol className="steps" aria-label="Setup steps">
      {steps.map((label, i) => (
        <li key={label} className={i === stepIndex ? 'current' : i < stepIndex ? 'done' : ''} aria-current={i === stepIndex ? 'step' : undefined}>
          <span className="num">{i + 1}</span> {label}
        </li>
      ))}
    </ol>
  );

  if (step === 'loading') {
    return (
      <main className="setup">
        {stepBar}
        <section className="panel">
          <h2>Loading your music</h2>
          <p className="hint">Only songs that match the genres and years you chose are kept.</p>
          <p className="progress" role="status">
            {!progress || progress.step === 'reading'
              ? 'Reading your listening…'
              : progress.step === 'genres'
                ? `Looking up genres: ${progress.done} of ${progress.total} artists`
                : `Finding the original release year: ${progress.done} of ${progress.total}`}
            <progress value={progress?.done ?? 0} max={progress?.total || 1} />
          </p>
        </section>
      </main>
    );
  }

  if (step === 'account') {
    return (
      <main className="setup">
        {stepBar}
        <section className="panel intro">
          <h1>Place the song on your timeline</h1>
          <p>
            A mystery song plays. Decide whether it came out before, after or between the years on your timeline. Get it
            right and the card is yours. The first to collect <strong>{target}</strong> cards wins.
          </p>
        </section>

        <section className="panel">
          <h2>Play with a Spotify login?</h2>
          <div className="mode-options" role="radiogroup" aria-label="Play with a Spotify login?">
            <ModeOption
              value="login"
              current={account}
              onSelect={setAccount}
              title="Log in with Spotify"
              detail="Play with your own music and every deck, and with Premium the full songs play right here. You first choose the music; logging in is the last step."
            />
            <ModeOption
              value="guest"
              current={account}
              onSelect={setAccount}
              title="Play without login"
              detail={`The classic hits through a hidden Spotify player (${deckSize.noLogin} songs). Full songs if this browser is signed in to Spotify, otherwise 30-second previews.`}
            />
          </div>
          {profile && (
            <p className="hint spotify-box">
              Logged in as <strong>{profile.display_name}</strong>.{' '}
              <button className="link" onClick={onLogout}>
                Log out
              </button>
            </p>
          )}
        </section>

        <button className="primary big" disabled={!account} onClick={() => setStep('music')}>
          Next: choose the music
        </button>
      </main>
    );
  }

  const isPremium = profile?.product === 'premium';
  const startLabel = !useLogin ? 'Start game' : !profile ? 'Log in with Spotify and start' : willLoad ? 'Load my music and start' : 'Start game';

  return (
    <main className="setup">
      {stepBar}
      <p>
        <button className="link" onClick={() => setStep('account')}>
          ← {useLogin ? 'Playing with a Spotify login' : 'Playing without login'}. Change
        </button>
      </p>

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
      </section>

      <section className="panel">
        <h2>Which songs?</h2>
        <p className="hint">Pick one or more. Songs from several decks are shuffled together.</p>
        <div className="mode-options deck-options" role="group" aria-label="Which songs?">
          {visibleDecks.map((d) => (
            <DeckOption key={d.id} title={d.title} detail={deckDetail(d.id, d.detail)} checked={activeDecks.includes(d.id)} onToggle={() => toggleDeck(d.id)} />
          ))}
        </div>
        {wantsMine && useLogin && (
          <MyMusic personal={personal} sources={sources} onSourcesChange={setSources} willLoad={willLoad} onForget={props.onPersonalForget} />
        )}
      </section>

      <DeckFilterPanel
        filter={filter}
        onChange={setFilter}
        presets={STANDARD_PRESETS}
        personalPresets={myPresets}
        count={songCount}
        total={unfilteredCount}
        pending={willLoad ? 'plus your matching Spotify songs, loaded when you start' : undefined}
        note={soundtrackWithGenres ? 'Soundtrack songs have no genre, so a genre choice leaves them out. Use years only to keep them.' : undefined}
      />

      <section className="panel">
        <h2>How should the music play?</h2>
        <div className="mode-options" role="radiogroup" aria-label="How should the music play?">
          {useLogin && (
            <ModeOption
              value="premium"
              current={playMode}
              onSelect={setMode}
              title="In the browser (Spotify Premium)"
              detail="Full songs played right here. Needs Spotify Premium."
            />
          )}
          <ModeOption
            value="embed"
            current={playMode}
            onSelect={setMode}
            title="Hidden Spotify player"
            detail={
              useLogin
                ? 'A covered-up Spotify player. Full songs if this browser is signed in to Spotify, otherwise 30-second previews.'
                : `A covered-up Spotify player. Full songs if this browser is signed in to Spotify, otherwise 30-second previews. Without a login it plays only songs with a known Spotify id (${deckSize.noLogin} of the classic hits, and your saved Spotify songs).`
            }
          />
          <ModeOption value="none" current={playMode} onSelect={setMode} title="No audio" detail="Try the rules, or play the music some other way." />
        </div>
        {profile && !isPremium && playMode === 'premium' && (
          <p className="warn">This account isn't Premium, so in-browser playback won't work. Choose the hidden Spotify player instead.</p>
        )}
      </section>

      {useLogin && (
        <section className="panel">
          <h2>Log in and start</h2>
          {profile ? (
            <p>
              Logged in as <strong>{profile.display_name}</strong> ({isPremium ? 'Premium' : profile.product}).{' '}
              <button className="link" onClick={onLogout}>
                Log out
              </button>
            </p>
          ) : (
            <>
              <p className="hint">
                {willLoad
                  ? 'Spotify asks you to log in and to allow the game to read the listening you ticked. Your songs are loaded right after, and the game starts.'
                  : 'Spotify asks you to log in, and the game starts when you come back.'}
              </p>
              {clientIdField}
            </>
          )}
          {authMessage && <p className="warn">{authMessage}</p>}
        </section>
      )}

      {error && <p className="warn center">{error}</p>}
      <button className={`primary big ${useLogin && !profile ? 'spotify' : ''}`} disabled={useLogin && !profile && !clientId.trim()} onClick={start}>
        {startLabel}
      </button>
    </main>
  );
}

function ModeOption<T extends string>(props: { value: T; current: T | null; onSelect: (v: T) => void; title: string; detail: string }) {
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
