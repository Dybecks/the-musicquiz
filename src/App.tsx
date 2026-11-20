import { useCallback, useEffect, useState } from 'react';
import { createGame, type GameState } from './game/engine';
import { getProfile, RateLimitError, type SpotifyProfile } from './spotify/api';
import { handleRedirect, isFriendLogin, isLoggedIn, login, logout, restoreHostLogin, takeAfterLogin } from './spotify/auth';
import { loadPersonalDeck } from './spotify/listening';
import type { PersonalDeck } from './spotify/personalDeck';
import type { PlaybackKind } from './spotify/playback';
import { Setup, type SetupValues } from './components/Setup';
import { Game } from './components/Game';
import { Remote, savedRemote } from './components/Remote';
import { isValidCode, normalizeCode } from './multiplayer/protocol';

const GAME_KEY = 'mq.game';
const MODE_KEY = 'mq.mode';
const PROFILE_KEY = 'mq.profile';

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

/** A `?join=CODE` link opens the join screen; the parameter is then removed from the address. */
function codeFromLink(): string | null {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('join');
  if (raw === null) return null;
  params.delete('join');
  const query = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  const code = normalizeCode(raw);
  return isValidCode(code) ? code : '';
}

export function App() {
  // Joining someone else's game: from a link, or carrying on after a reload.
  const [remote, setRemote] = useState<{ code?: string } | null>(() => {
    const code = codeFromLink();
    if (code !== null) return { code: code || undefined };
    return savedRemote() ? {} : null;
  });
  const [game, setGame] = useState<GameState | null>(() => loadJson<GameState>(GAME_KEY));
  const [mode, setMode] = useState<PlaybackKind>(() => loadJson<PlaybackKind>(MODE_KEY) ?? 'embed');
  const [profile, setProfile] = useState<SpotifyProfile | null>(null);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [personal, setPersonal] = useState<PersonalDeck | null>(loadPersonalDeck);
  const [returnedFromLogin, setReturnedFromLogin] = useState(false);

  const refreshProfile = useCallback(async () => {
    if (!isLoggedIn()) {
      setProfile(null);
      return;
    }
    try {
      const p = await getProfile();
      localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
      setProfile(p);
    } catch (e) {
      // While Spotify's request limit is used up, the login still holds:
      // keep the profile from last time instead of logging the host out.
      const saved = e instanceof RateLimitError ? loadJson<SpotifyProfile>(PROFILE_KEY) : null;
      setProfile(saved);
      if (!saved) setAuthMessage(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const { err, after } = await finishLogin();
      if (err) setAuthMessage(err);
      if ((after === 'music' || after === 'start') && !err) setReturnedFromLogin(true);
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
    // Spread the songs over the decades, unless the host chose which years to play.
    const order = values.spreadDecades ? 'decades' : 'random';
    setGame({ ...createGame({ playerNames: values.players, targetCards: values.targetCards, songs: values.songs, order }), refill: values.refill });
  };

  return (
    <div className="app">
      <header className="brand">
        <span className="brand-mark">♪</span> The Music Quiz
      </header>
      {remote ? (
        <Remote initialCode={remote.code} onLeave={() => setRemote(null)} />
      ) : game ? (
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
          personal={personal}
          returnedFromLogin={returnedFromLogin}
          onReturnHandled={() => setReturnedFromLogin(false)}
          onLogin={(extraScopes) =>
            login({ extraScopes, afterLogin: 'music' }).catch((e) => setAuthMessage(e instanceof Error ? e.message : String(e)))
          }
          onPersonalChange={setPersonal}
          onLogout={() => {
            logout();
            setProfile(null);
          }}
          onStart={start}
          onJoin={() => setRemote({})}
        />
      )}
    </div>
  );
}
