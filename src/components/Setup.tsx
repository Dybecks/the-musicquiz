import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Song } from '../game/engine';
import { onSpotifyWait, spotifyBlockedUntil, type SpotifyProfile } from '../spotify/api';
import { BUILT_IN_CLIENT_ID, getClientIdOverride, hasScopes, redirectUri, setClientId } from '../spotify/auth';
import type { PlaybackKind } from '../spotify/playback';
import { DECKS, chooseSongs, deckSongs, normalizeDecks, parseSavedDecks, playableSongs, type DeckId } from '../data/decks';
import {
  MAX_GENRES,
  PLAYLIST_SCOPES,
  SEARCH_GENRES,
  newGenrePlan,
  newPlaylistPlan,
  startList,
  type RefillPlan,
  fetchPlaylists,
  savePersonalDeck,
  type BuildProgress,
  type PlaylistSummary,
} from '../spotify/listening';
import { hostContributor, personalSongs, summarize, type PersonalDeck } from '../spotify/personalDeck';
import { locale, msg, useT } from '../i18n';
import { Rich } from '../i18n/Rich';

export interface SetupValues {
  players: string[];
  targetCards: number;
  mode: PlaybackKind;
  songs: Song[];
  /** Spread the songs over the decades (no year span was chosen). */
  spreadDecades: boolean;
  /** Whether the game may use the Spotify login (search, Premium playback). */
  loggedIn: boolean;
  /** Where to fetch more songs from while playing (own lists). */
  refill?: RefillPlan;
}

interface Props {
  profile: SpotifyProfile | null;
  authMessage: string | null;
  personal: PersonalDeck | null;
  /** Set when the host just came back from logging in: carry on with the music. */
  returnedFromLogin: boolean;
  onReturnHandled: () => void;
  onLogin: (extraScopes: string[]) => void;
  onLogout: () => void;
  onPersonalChange: (deck: PersonalDeck | null) => void;
  onStart: (values: SetupValues) => void;
  /** Join a game someone else is hosting, with its code. */
  onJoin: () => void;
  /** The players or teams, which phones can rename before the start. */
  players: string[];
  /** The players or teams as they are typed, so phones can pick a team before the start. */
  onPlayersChange: (names: string[]) => void;
  /** Inviting phones (the share panel), shown with the players. */
  invite: ReactNode;
}

/** Whether the host plays with a Spotify login. */
type Account = 'login' | 'guest';
/** Where the songs come from. */
type Source = 'ready' | 'own';
type Step = 'account' | 'source' | 'ready' | 'own' | 'genres' | 'playlists' | 'building' | 'players';

const PLAYERS_KEY = 'mq.players';
const TARGET_KEY = 'mq.target';
const DECK_KEY = 'mq.deck';
const ACCOUNT_KEY = 'mq.account';
const SOURCE_KEY = 'mq.source';
const GENRES_KEY = 'mq.ownGenres';
const YEARS_KEY = 'mq.ownYears';
const PLAYLISTS_KEY = 'mq.ownPlaylists';

const THIS_YEAR = new Date().getFullYear();
const FIRST_YEAR = 1950;

function loadJson<T>(key: string, fallback: T, valid: (v: unknown) => boolean = () => true): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (v !== null && valid(v)) return v as T;
  } catch {
    /* ignore */
  }
  return fallback;
}
const saveJson = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
};

function loadAccount(): Account | null {
  const saved = localStorage.getItem(ACCOUNT_KEY);
  return saved === 'login' || saved === 'guest' ? saved : null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clampYear = (y: number) => Math.max(FIRST_YEAR, Math.min(THIS_YEAR, Math.round(y)));
const decadesLabel = (from: number, to: number) => (from === to ? String(from) : `${from}–${to}`);

export function Setup(props: Props) {
  const t = useT();
  const ts = t.setup;
  const { profile, authMessage, personal, onLogout } = props;
  const [account, setAccountState] = useState<Account | null>(loadAccount);
  const [source, setSourceState] = useState<Source>(() => (localStorage.getItem(SOURCE_KEY) === 'own' ? 'own' : 'ready'));
  const [step, setStep] = useState<Step>(() => (props.returnedFromLogin && loadAccount() === 'login' ? 'source' : 'account'));
  const [players, setPlayers] = useState<string[]>(() => loadJson(PLAYERS_KEY, [msg().app.defaultTeam(1), msg().app.defaultTeam(2)], (v) => Array.isArray(v) && v.length > 0));
  const [target, setTarget] = useState<number>(() => Number(localStorage.getItem(TARGET_KEY)) || 10);
  const [clientIdOverride, setClientIdOverride] = useState(getClientIdOverride);
  const clientId = clientIdOverride.trim() || BUILT_IN_CLIENT_ID;
  const [error, setError] = useState<string | null>(null);
  const [decks, setDecks] = useState<DeckId[]>(() => parseSavedDecks(localStorage.getItem(DECK_KEY)).filter((d) => d !== 'mine'));
  const [genres, setGenres] = useState<string[]>(() => loadJson(GENRES_KEY, ['pop', 'rock'], Array.isArray));
  const [years, setYears] = useState<[number, number]>(() => loadJson(YEARS_KEY, [1970, THIS_YEAR], (v) => Array.isArray(v) && v.length === 2));
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [playlistTotal, setPlaylistTotal] = useState(0);
  const [picked, setPicked] = useState<string[]>(() => loadJson(PLAYLISTS_KEY, [], Array.isArray));
  const [listBusy, setListBusy] = useState(false);
  const [progress, setProgress] = useState<BuildProgress | null>(null);
  const [buildReturn, setBuildReturn] = useState<Step>('own');
  const buildId = useRef(0);
  const [waitUntil, setWaitUntil] = useState(0);

  const [now, setNow] = useState(() => Date.now());

  // When Spotify asks the game to pause, the loading screen counts down and
  // carries on by itself.
  useEffect(() => onSpotifyWait(setWaitUntil), []);
  const waiting = waitUntil > now;
  useEffect(() => {
    if (waitUntil <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    setNow(Date.now());
    return () => clearInterval(timer);
  }, [waitUntil]);
  const secondsLeft = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  const waitNotice = waiting && (
    <p className="info warn-info" role="status">
      <span aria-hidden="true">⏳</span>
      <span>
        {ts.spotifyPause}{' '}
        <strong>{secondsLeft >= 60 ? `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}` : ts.seconds(secondsLeft)}</strong>.
      </span>
    </p>
  );

  useEffect(() => {
    saveJson(PLAYERS_KEY, players);
    props.onPlayersChange(players);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players]);
  // A team renamed from a phone.
  useEffect(() => {
    setPlayers((cur) => (cur.join('\n') === props.players.join('\n') ? cur : props.players));
  }, [props.players]);
  useEffect(() => localStorage.setItem(TARGET_KEY, String(target)), [target]);

  useEffect(() => {
    if (props.returnedFromLogin) props.onReturnHandled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setAccount = (a: Account) => {
    setAccountState(a);
    localStorage.setItem(ACCOUNT_KEY, a);
  };
  const setSource = (s: Source) => {
    setSourceState(s);
    localStorage.setItem(SOURCE_KEY, s);
  };
  const go = (s: Step) => {
    setError(null);
    setStep(s);
  };

  const useLogin = account === 'login';
  const loggedIn = useLogin && !!profile;
  const canReadPlaylists = loggedIn && hasScopes(PLAYLIST_SCOPES);
  const isPremium = profile?.product === 'premium';
  // The music plays the way step 1 decided: in the browser with a (Premium)
  // login, otherwise through the hidden Spotify player.
  // While Spotify's request limit is used up, play through the hidden player,
  // which needs no requests for songs with a known Spotify link.
  const blockedUntil = spotifyBlockedUntil();
  const canAsk = loggedIn && !blockedUntil;
  const mode: PlaybackKind = canAsk && isPremium ? 'premium' : 'embed';
  const owner = hostContributor(personal);
  const ownList = owner && profile && owner.userId === profile.id ? owner : undefined;
  const ownSongs = ownList ? personalSongs(personal) : [];
  const names = players.map((p) => p.trim()).filter(Boolean);

  const readyDecks = DECKS.filter((d) => d.id !== 'mine');
  const activeDecks = normalizeDecks(decks);
  const readySongs = chooseSongs({ decks: activeDecks, mode, loggedIn: canAsk, personal: null });
  const songs = source === 'own' ? ownSongs : readySongs;

  const toggleDeck = (id: DeckId) => {
    const next = activeDecks.includes(id) ? activeDecks.filter((d) => d !== id) : normalizeDecks([...activeDecks, id]);
    if (next.length === 0) return; // keep at least one deck
    setDecks(next);
    saveJson(DECK_KEY, next);
  };

  const deckCount = (id: DeckId) => {
    const all = deckSongs(id, null).length;
    const playable = playableSongs(deckSongs(id, null), mode, canAsk).length;
    return ts.deckCount(playable, all);
  };

  // ---- Building the host's own list ----

  const finishBuild = (
    id: number,
    built: Song[],
    label: string,
    from: Step,
    sources: PersonalDeck['contributors'][number]['sources'],
    note: string | null,
    plan: RefillPlan | null,
  ) => {
    if (id !== buildId.current) return; // cancelled
    setProgress(null);
    if (built.length < 5) {
      setError(note ?? msg().setup.tooFewFound(built.length, from === 'genres'));
      setStep(from);
      return;
    }
    const deck = savePersonalDeck({
      role: 'host',
      userId: profile!.id,
      name: profile!.display_name || msg().app.you,
      sources,
      builtAt: new Date().toISOString(),
      label,
      songs: built,
      plan: plan ?? undefined,
    });
    props.onPersonalChange(deck);
    setSource('own');
    setStep('players');
    setError(note);
  };

  const failBuild = (id: number, e: unknown, from: Step) => {
    if (id !== buildId.current) return;
    setProgress(null);
    setError(message(e));
    setStep(from);
  };

  const buildGenres = () => {
    if (!profile) return;
    const id = ++buildId.current;
    const [from, to] = years;
    const label = `${SEARCH_GENRES.filter((g) => genres.includes(g.id)).map((g) => g.label).join(', ')} · ${decadesLabel(from, to)}`;
    setBuildReturn('genres');
    go('building');
    startList(newGenrePlan(genres, Math.min(from, to), Math.max(from, to)), setProgress).then(
      ({ songs: built, plan, note }) => finishBuild(id, built, label, 'genres', [], note, plan),
      (e) => failBuild(id, e, 'genres'),
    );
  };

  const chosenPlaylists = (playlists ?? []).filter((p) => picked.includes(p.id));
  const buildPlaylists = () => {
    if (!profile) return;
    const id = ++buildId.current;
    const label = chosenPlaylists.map((p) => p.name).join(', ');
    setBuildReturn('playlists');
    go('building');
    startList(newPlaylistPlan(chosenPlaylists), setProgress).then(
      ({ songs: built, plan, note }) => finishBuild(id, built, label, 'playlists', ['playlists'], note, plan),
      (e) => failBuild(id, e, 'playlists'),
    );
  };

  const cancelBuild = () => {
    buildId.current++;
    setProgress(null);
    go(buildReturn);
  };

  const loadPlaylists = async (more = false) => {
    setListBusy(true);
    setError(null);
    try {
      const page = await fetchPlaylists(more ? (playlists?.length ?? 0) : 0);
      setPlaylists(more ? [...(playlists ?? []), ...page.playlists] : page.playlists);
      setPlaylistTotal(page.total);
    } catch (e) {
      setError(message(e));
    } finally {
      setListBusy(false);
    }
  };

  // One request lists every playlist, made when the screen opens.
  useEffect(() => {
    if (step === 'playlists' && playlists === null && !listBusy && canReadPlaylists) void loadPlaylists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const togglePlaylist = (id: string) => {
    const next = picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id];
    setPicked(next);
    saveJson(PLAYLISTS_KEY, next);
  };

  const toggleGenre = (id: string) => {
    const next = genres.includes(id) ? genres.filter((g) => g !== id) : genres.length >= MAX_GENRES ? genres : [...genres, id];
    setGenres(next);
    saveJson(GENRES_KEY, next);
  };
  const setYear = (i: 0 | 1, value: number) => {
    const next: [number, number] = [...years];
    next[i] = value;
    setYears(next);
  };
  const commitYears = () => {
    let [from, to] = years.map(clampYear) as [number, number];
    if (from > to) [from, to] = [to, from];
    setYears([from, to]);
    saveJson(YEARS_KEY, [from, to]);
  };

  // ---- Start ----

  const start = () => {
    setError(null);
    if (names.length === 0) return setError(ts.addPlayer);
    if (songs.length < names.length + 1) return setError(ts.tooFewSongs);
    props.onStart({
      players: names,
      targetCards: target,
      mode,
      songs,
      spreadDecades: true,
      loggedIn: canAsk,
      refill: source === 'own' ? (ownList?.plan as RefillPlan | undefined) : undefined,
    });
  };

  // ---- Shared bits ----

  const steps = ts.steps;
  const stepIndex = step === 'account' ? 0 : step === 'players' ? 2 : 1;
  const stepBar = (
    <ol className="steps" aria-label={ts.stepsLabel}>
      {steps.map((label, i) => (
        <li key={label} className={i === stepIndex ? 'current' : i < stepIndex ? 'done' : ''} aria-current={i === stepIndex ? 'step' : undefined}>
          <span className="num">{i < stepIndex ? '✓' : i + 1}</span> {label}
        </li>
      ))}
    </ol>
  );
  const back = (to: Step, label = ts.back) => (
    <p>
      <button className="link" onClick={() => go(to)}>
        ← {label}
      </button>
    </p>
  );
  const errorLine = error && <p className="warn center">{error}</p>;

  // The game ships with its own Spotify app, so the Client ID field is tucked
  // away for hosts who want to use their own app instead.
  const clientIdInput = (
    <>
      <label className="field">
        <span>
          {ts.clientIdLabel}
          {BUILT_IN_CLIENT_ID ? ts.clientIdOwn : ''}
        </span>
        <input
          value={clientIdOverride}
          placeholder={ts.clientIdPlaceholder}
          onChange={(e) => {
            setClientIdOverride(e.target.value);
            setClientId(e.target.value);
          }}
        />
      </label>
      <p className="hint">
        {ts.redirectBefore} <code>{redirectUri()}</code> {ts.redirectAfter}
      </p>
    </>
  );
  const clientIdField = BUILT_IN_CLIENT_ID ? (
    <details className="own-app" open={!!clientIdOverride}>
      <summary>{ts.ownApp}</summary>
      {clientIdInput}
    </details>
  ) : (
    clientIdInput
  );

  // ---- Step 1: Spotify ----

  if (step === 'account') {
    const needsLogin = useLogin && !canReadPlaylists;
    return (
      <main className="setup flow">
        {stepBar}
        <section className="panel intro">
          <h1>{ts.introTitle}</h1>
          <p>
            <Rich text={ts.intro(target)} />
          </p>
        </section>

        <section className="panel">
          <h2>{ts.loginQuestion}</h2>
          <div className="mode-options" role="radiogroup" aria-label={ts.loginQuestion}>
            <ModeOption
              value="login"
              current={account}
              onSelect={setAccount}
              title={ts.loginTitle}
              detail={ts.loginDetail}
            />
            <ModeOption
              value="guest"
              current={account}
              onSelect={setAccount}
              title={ts.guestTitle}
              detail={ts.guestDetail}
            />
          </div>
          {profile && (
            <p className="hint spotify-box">
              <Rich text={ts.loggedInAs(profile.display_name)} />{' '}
              <button className="link" onClick={onLogout}>
                {ts.logOut}
              </button>
            </p>
          )}
          {useLogin && !profile && clientIdField}
          {authMessage && <p className="warn">{authMessage}</p>}
        </section>

        {needsLogin ? (
          <button className="spotify big" disabled={!clientId.trim()} onClick={() => props.onLogin(PLAYLIST_SCOPES)}>
            {profile ? ts.allowPlaylists : ts.loginTitle}
          </button>
        ) : (
          <button className="primary big" disabled={!account} onClick={() => go('source')}>
            {ts.nextMusic}
          </button>
        )}
        <p className="join-line center">
          {ts.gotCode}{' '}
          <button className="link" onClick={props.onJoin}>
            {ts.joinOnPhone}
          </button>
        </p>
      </main>
    );
  }

  // ---- Step 2: Music ----

  if (step === 'source') {
    return (
      <main className="setup flow">
        {stepBar}
        {back('account', useLogin ? ts.playingWithLogin : ts.playingWithoutLogin)}
        <h2 className="screen-title">{ts.sourceQuestion}</h2>
        <div className="choices" role="radiogroup" aria-label={ts.sourceQuestion}>
          <Choice
            icon="📦"
            title={ts.readyTitle}
            detail={ts.readyDetail}
            tag={ts.readyTag}
            selected={source === 'ready'}
            onSelect={() => setSource('ready')}
          />
          <Choice
            icon="🎛️"
            title={ts.ownTitle}
            detail={ts.ownDetail}
            tag={ts.ownTag}
            tagKind="warn"
            selected={source === 'own'}
            disabled={!loggedIn}
            onSelect={() => setSource('own')}
          />
        </div>
        {!loggedIn && (
          <p className="hint">
            <button className="link" onClick={() => go('account')}>
              {ts.loginForOwn}
            </button>
          </p>
        )}
        <button className="primary big" onClick={() => go(source === 'own' && loggedIn ? 'own' : 'ready')}>
          {ts.continue}
        </button>
      </main>
    );
  }

  if (step === 'ready') {
    return (
      <main className="setup flow">
        {stepBar}
        {back('source')}
        <h2 className="screen-title">{ts.pickLists}</h2>
        <p className="hint">{ts.pickListsHint}</p>
        <div className="mode-options deck-options" role="group" aria-label={ts.pickLists}>
          {readyDecks.map((d) => (
            <DeckOption key={d.id} title={t.decks[d.id].title} detail={t.decks[d.id].detail} count={deckCount(d.id)} checked={activeDecks.includes(d.id)} onToggle={() => toggleDeck(d.id)} />
          ))}
        </div>
        {!loggedIn && <p className="hint">{ts.withoutLoginHint}</p>}
        {errorLine}
        <button
          className="primary big"
          disabled={readySongs.length === 0}
          onClick={() => {
            setSource('ready');
            go('players');
          }}
        >
          {ts.continueWith(readySongs.length)}
        </button>
      </main>
    );
  }

  if (step === 'own') {
    return (
      <main className="setup flow">
        {stepBar}
        {back('source')}
        <h2 className="screen-title">{ts.howPick}</h2>
        <p className="hint">
          <Rich text={ts.loggedInAs(profile?.display_name ?? '')} />
        </p>
        <div className="choices">
          <Choice icon="🎸" title={ts.byGenre} detail={ts.byGenreDetail} onSelect={() => go('genres')} />
          <Choice icon="📃" title={ts.fromPlaylists} detail={ts.fromPlaylistsDetail} onSelect={() => go('playlists')} />
          {ownList && ownSongs.length > 0 && (
            <Choice
              icon="↺"
              title={ts.lastList}
              detail={ts.lastListDetail(ownList.label ?? ts.yourSongs, ownSongs.length)}
              onSelect={() => {
                setSource('own');
                go('players');
              }}
            />
          )}
        </div>
        {errorLine}
      </main>
    );
  }

  if (step === 'genres') {
    const [from, to] = years;
    return (
      <main className="setup flow">
        {stepBar}
        {back('own')}
        <h2 className="screen-title">{ts.genresAndYears}</h2>
        <section className="panel">
          <h2>
            {ts.genres} <span className="muted">{ts.pickGenres(MAX_GENRES)}</span>
          </h2>
          <div className="chips" role="group" aria-label={ts.genres}>
            {SEARCH_GENRES.map((g) => (
              <button
                key={g.id}
                role="checkbox"
                aria-checked={genres.includes(g.id)}
                className={`chip ${genres.includes(g.id) ? 'selected' : ''}`}
                disabled={!genres.includes(g.id) && genres.length >= MAX_GENRES}
                onClick={() => toggleGenre(g.id)}
              >
                {g.label}
              </button>
            ))}
          </div>
        </section>
        <section className="panel">
          <h2>{ts.years}</h2>
          <div className="year-range">
            <label className="field">
              <span>{ts.from}</span>
              <input type="number" inputMode="numeric" min={FIRST_YEAR} max={THIS_YEAR} value={from} onChange={(e) => setYear(0, Number(e.target.value))} onBlur={commitYears} />
            </label>
            <label className="field">
              <span>{ts.to}</span>
              <input type="number" inputMode="numeric" min={FIRST_YEAR} max={THIS_YEAR} value={to} onChange={(e) => setYear(1, Number(e.target.value))} onBlur={commitYears} />
            </label>
          </div>
          <div className="chips decade-chips">
            {[1960, 1970, 1980, 1990, 2000, 2010, 2020].map((d) => (
              <button
                key={d}
                className={`chip ${from === d && to === Math.min(d + 9, THIS_YEAR) ? 'selected' : ''}`}
                onClick={() => {
                  setYears([d, Math.min(d + 9, THIS_YEAR)]);
                  saveJson(YEARS_KEY, [d, Math.min(d + 9, THIS_YEAR)]);
                }}
              >
                {ts.decade(d)}
              </button>
            ))}
            <button
              className={`chip ${from === FIRST_YEAR && to === THIS_YEAR ? 'selected' : ''}`}
              onClick={() => {
                setYears([FIRST_YEAR, THIS_YEAR]);
                saveJson(YEARS_KEY, [FIRST_YEAR, THIS_YEAR]);
              }}
            >
              {ts.allYears}
            </button>
          </div>
        </section>
        {genres.length > 0 && (
          <p className="info">
            <span aria-hidden="true">⚡</span>
            <span>
              <Rich text={ts.genreFetchInfo} />
            </span>
          </p>
        )}
        {errorLine}
        <button className="primary big" disabled={genres.length === 0} onClick={buildGenres}>
          {ts.buildList}
        </button>
      </main>
    );
  }

  if (step === 'playlists') {
    const songsPicked = chosenPlaylists.reduce((n, p) => n + p.tracks, 0);
    return (
      <main className="setup flow">
        {stepBar}
        {back('own')}
        <h2 className="screen-title">{ts.yourPlaylists}</h2>
        {!canReadPlaylists ? (
          <>
            <p className="hint">{ts.needPlaylistOk}</p>
            <button className="spotify big" onClick={() => props.onLogin(PLAYLIST_SCOPES)}>
              {ts.allowPlaylists}
            </button>
          </>
        ) : playlists === null ? (
          <>
            {waitNotice}
            <p className="hint" role="status">
              {listBusy ? ts.loadingPlaylists : ''}
            </p>
          </>
        ) : (
          <>
            <p className="hint">{ts.playlistCount(playlistTotal)}</p>
            {playlists.length === 0 && <p className="hint">{ts.noPlaylists}</p>}
            <div className="mode-options deck-options" role="group" aria-label={ts.yourPlaylists}>
              {playlists.map((p) => (
                <DeckOption
                  key={p.id}
                  title={p.name}
                  detail={p.owner ? ts.playlistBy(p.owner) : ''}
                  count={String(p.tracks)}
                  image={p.image}
                  checked={picked.includes(p.id)}
                  onToggle={() => togglePlaylist(p.id)}
                />
              ))}
            </div>
            {playlists.length < playlistTotal && (
              <button className="ghost add" disabled={listBusy} onClick={() => void loadPlaylists(true)}>
                {listBusy ? ts.loading : ts.showMore(playlistTotal - playlists.length)}
              </button>
            )}
            {chosenPlaylists.length > 0 && (
              <p className="info warn-info">
                <span aria-hidden="true">ℹ️</span>
                <span>
                  <Rich text={ts.playlistFetchInfo} />
                </span>
              </p>
            )}
          </>
        )}
        {errorLine}
        {canReadPlaylists && (
          <button className="primary big" disabled={chosenPlaylists.length === 0} onClick={buildPlaylists}>
            {chosenPlaylists.length ? ts.usePlaylists(chosenPlaylists.length, songsPicked) : ts.pickOnePlaylist}
          </button>
        )}
      </main>
    );
  }

  if (step === 'building') {
    return (
      <main className="setup flow">
        {stepBar}
        <h2 className="screen-title">{buildReturn === 'genres' ? ts.building : ts.readingPlaylists}</h2>
        {waitNotice}
        <section className="panel">
          <p className="progress" role="status">
            {progress?.label ?? ts.starting}
            <progress value={progress?.done ?? 0} max={progress?.total || 1} />
            {progress && progress.total > 0 && (
              <span className="hint">{ts.progress(progress.done, progress.total)}</span>
            )}
          </p>
        </section>
        <button className="ghost big" onClick={cancelBuild}>
          {ts.cancel}
        </button>
      </main>
    );
  }

  // ---- Step 3: Players & play ----

  const summary = summarize(songs);
  const what =
    source === 'own'
      ? ownList?.label ?? ts.ownList
      : activeDecks
          .map((id) => t.decks[id].title)
          .filter(Boolean)
          .join(', ');
  return (
    <main className="setup flow">
      {stepBar}
      <div className="music-summary">
        <span>
          <strong>{source === 'own' && ownList?.plan ? ts.songsToStart(songs.length) : ts.songs(songs.length)}</strong> · {what}
        </span>
        <button className="link" onClick={() => go(source === 'own' ? 'own' : 'source')}>
          {ts.change}
        </button>
      </div>
      {source === 'own' && ownList?.plan ? <p className="hint">{ts.moreFetched}</p> : null}
      {source === 'own' && summary.decades.length > 1 && (
        <ul className="decades" aria-label={ts.perDecade}>
          {summary.decades.map(([decade, count]) => (
            <li key={decade}>
              <span className="bar" style={{ height: `${Math.max(6, (count / Math.max(...summary.decades.map(([, n]) => n))) * 100)}%` }} />
              <span className="n">{count}</span>
              <span className="d">{ts.decade(decade)}</span>
            </li>
          ))}
        </ul>
      )}

      <section className="panel">
        <h2>{ts.playersOrTeams}</h2>
        <ul className="player-list">
          {players.map((name, i) => (
            <li key={i}>
              <input
                aria-label={ts.playerName(i + 1)}
                value={name}
                maxLength={24}
                onChange={(e) => setPlayers(players.map((p, j) => (j === i ? e.target.value : p)))}
              />
              {players.length > 1 && (
                <button className="ghost" aria-label={ts.remove(name)} onClick={() => setPlayers(players.filter((_, j) => j !== i))}>
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
        {players.length < 8 && (
          <button className="ghost add" onClick={() => setPlayers([...players, t.app.defaultTeam(players.length + 1)])}>
            {ts.addPlayerButton}
          </button>
        )}

        <label className="field">
          <span>{ts.cardsToWin}</span>
          <input type="number" min={3} max={30} value={target} onChange={(e) => setTarget(Math.max(3, Math.min(30, Number(e.target.value) || 10)))} />
        </label>
        <p className="hint">
          {mode === 'premium'
            ? ts.playsPremium
            : loggedIn && blockedUntil
              ? ts.playsBlocked(new Date(blockedUntil).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }))
              : loggedIn
              ? ts.playsNotPremium
              : ts.playsGuest}
        </p>
      </section>

      {props.invite}

      {errorLine}
      <button className="primary big" onClick={start}>
        {ts.startGame}
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

function Choice(props: {
  icon: string;
  title: string;
  detail: string;
  tag?: string;
  tagKind?: 'ok' | 'warn';
  selected?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      role={props.selected === undefined ? undefined : 'radio'}
      aria-checked={props.selected}
      className={`choice ${props.selected ? 'selected' : ''}`}
      disabled={props.disabled}
      onClick={props.onSelect}
    >
      <span className="choice-icon" aria-hidden="true">
        {props.icon}
      </span>
      <strong>{props.title}</strong>
      <span>{props.detail}</span>
      {props.tag && <small className={`tag ${props.tagKind ?? 'ok'}`}>{props.tag}</small>}
    </button>
  );
}

function DeckOption(props: { title: string; detail: string; count?: string; image?: string | null; checked: boolean; onToggle: () => void }) {
  return (
    <button
      role="checkbox"
      aria-checked={props.checked}
      className={`mode deck ${props.image !== undefined ? 'with-cover' : ''} ${props.checked ? 'selected' : ''}`}
      onClick={props.onToggle}
    >
      <span className="tick" aria-hidden="true">
        {props.checked ? '✓' : ''}
      </span>
      {props.image !== undefined && (props.image ? <img className="cover" src={props.image} alt="" loading="lazy" /> : <span className="cover" aria-hidden="true" />)}
      <strong>{props.title}</strong>
      {props.count && <span className="count">{props.count}</span>}
      <span className="detail">{props.detail}</span>
    </button>
  );
}
