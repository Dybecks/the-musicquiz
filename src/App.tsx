import { useCallback, useEffect, useState } from 'react';
import { createGame, type GameState } from './game/engine';
import { DEFAULT_SONGS, NO_LOGIN_SONGS } from './data/songs';
import { chooseSongs } from './data/decks';
import { getProfile, type SpotifyProfile } from './spotify/api';
import { handleRedirect, isFriendLogin, isLoggedIn, login, logout, restoreHostLogin, takeAfterLogin } from './spotify/auth';
import { loadPersonalDeck } from './spotify/listening';
import type { PersonalDeck } from './spotify/personalDeck';
import type { PlaybackKind } from './spotify/playback';
import { Setup, type SetupValues } from './components/Setup';
import { Game } from './components/Game';

const GAME_KEY = 'mq.game';
const MODE_KEY = 'mq.mode';

function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/**
 * Finishes a Spotify login once per page load (React may run effects twice),
 * and says what was asked to happen after it.
 */
let startup: Promise<{ err: string | null; after: string | null }> | null = null;
function finishLogin() {
  startup ??= (async () => {
    const err = await handleRedirect().catch((e) => String(e));
    const after = takeAfterLogin();
    // A friend's login only lasts while their music loads.
    if ((after !== 'friend' || err) && isFriendLogin()) restoreHostLogin();
    return { err, after };
  })();
  return startup;
}

export function App() {
  const [game, setGame] = useState<GameState | null>(() => loadJson<GameState>(GAME_KEY));
  const [mode, setMode] = useState<PlaybackKind>(() => loadJson<PlaybackKind>(MODE_KEY) ?? 'embed');
  const [profile, setProfile] = useState<SpotifyProfile | null>(null);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [personal, setPersonal] = useState<PersonalDeck | null>(loadPersonalDeck);
  const [autoStart, setAutoStart] = useState(false);
  const [friendReturn, setFriendReturn] = useState(false);

  const refreshProfile = useCallback(async () => {
    if (!isLoggedIn()) {
      setProfile(null);
      return;
    }
    try {
      setProfile(await getProfile());
    } catch (e) {
      setProfile(null);
      setAuthMessage(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const { err, after } = await finishLogin();
      if (err) setAuthMessage(err);
      if (after === 'friend' && !err) setFriendReturn(true);
      if (after === 'start' && !err) setAutoStart(true);
      await refreshProfile();
      setAuthChecked(true);
    })();
  }, [refreshProfile]);

  useEffect(() => {
    if (game) localStorage.setItem(GAME_KEY, JSON.stringify(game));
    else localStorage.removeItem(GAME_KEY);
  }, [game]);

  const start = (values: SetupValues) => {
    localStorage.setItem(MODE_KEY, JSON.stringify(values.mode));
    setMode(values.mode);
    const songs = chooseSongs({ decks: values.decks, mode: values.mode, loggedIn: values.loggedIn, personal: values.personal, filter: values.filter });
    // Spread the songs over the decades, unless the host chose which years to play.
    const order = values.filter.fromYear === null && values.filter.toYear === null ? 'decades' : 'random';
    setGame(createGame({ playerNames: values.players, targetCards: values.targetCards, songs, order }));
  };

  return (
    <div className="app">
      <header className="brand">
        <span className="brand-mark">♪</span> The Music Quiz
      </header>
      {game ? (
        <Game
          state={game}
          mode={mode}
          onModeChange={(m) => {
            localStorage.setItem(MODE_KEY, JSON.stringify(m));
            setMode(m);
          }}
          onChange={setGame}
          onQuit={() => setGame(null)}
        />
      ) : !authChecked ? (
        <p className="hint center">Checking Spotify login…</p>
      ) : (
        <Setup
          profile={profile}
          authMessage={authMessage}
          initialMode={mode}
          onModeChange={(m) => {
            localStorage.setItem(MODE_KEY, JSON.stringify(m));
            setMode(m);
          }}
          deckSize={{ all: DEFAULT_SONGS.length, noLogin: NO_LOGIN_SONGS.length }}
          personal={personal}
          autoStart={autoStart}
          onAutoStartHandled={() => setAutoStart(false)}
          onLogin={(extraScopes) =>
            login({ extraScopes, afterLogin: 'start' }).catch((e) => setAuthMessage(e instanceof Error ? e.message : String(e)))
          }
          onPersonalChange={setPersonal}
          friendReturn={friendReturn}
          onFriendLogin={(scopes) =>
            login({ extraScopes: scopes, afterLogin: 'friend', asFriend: true }).catch((e) =>
              setAuthMessage(e instanceof Error ? e.message : String(e)),
            )
          }
          onFriendDone={() => {
            setFriendReturn(false);
            restoreHostLogin();
            void refreshProfile();
          }}
          onLogout={() => {
            logout();
            setProfile(null);
          }}
          onStart={start}
        />
      )}
    </div>
  );
}
