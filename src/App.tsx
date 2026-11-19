import { useCallback, useEffect, useState } from 'react';
import { createGame, type GameState } from './game/engine';
import { DEFAULT_SONGS, NO_LOGIN_SONGS } from './data/songs';
import { chooseSongs } from './data/decks';
import { getProfile, type SpotifyProfile } from './spotify/api';
import { handleRedirect, isLoggedIn, login, logout, takeAfterLogin } from './spotify/auth';
import { forgetPersonalDeck, loadPersonalDeck, savePersonalDeck } from './spotify/listening';
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

export function App() {
  const [game, setGame] = useState<GameState | null>(() => loadJson<GameState>(GAME_KEY));
  const [mode, setMode] = useState<PlaybackKind>(() => loadJson<PlaybackKind>(MODE_KEY) ?? 'embed');
  const [profile, setProfile] = useState<SpotifyProfile | null>(null);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [personal, setPersonal] = useState<PersonalDeck | null>(loadPersonalDeck);
  const [autoGather, setAutoGather] = useState(false);

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
      const err = await handleRedirect().catch((e) => String(e));
      if (err) setAuthMessage(err);
      if (takeAfterLogin() === 'gather') setAutoGather(true);
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
    const songs = chooseSongs({ decks: values.decks, mode: values.mode, loggedIn: !!profile, personal, filter: values.filter });
    setGame(createGame({ playerNames: values.players, targetCards: values.targetCards, songs }));
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
      ) : (
        <Setup
          authChecked={authChecked}
          profile={profile}
          authMessage={authMessage}
          initialMode={mode}
          deckSize={{ all: DEFAULT_SONGS.length, noLogin: NO_LOGIN_SONGS.length }}
          personal={personal}
          autoGather={autoGather}
          onAutoGatherHandled={() => setAutoGather(false)}
          onLogin={(extraScopes) =>
            login(extraScopes ? { extraScopes, afterLogin: 'gather' } : {}).catch((e) =>
              setAuthMessage(e instanceof Error ? e.message : String(e)),
            )
          }
          onPersonalBuilt={(contributor) => setPersonal(savePersonalDeck(contributor))}
          onPersonalForget={() => {
            forgetPersonalDeck();
            setPersonal(null);
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
