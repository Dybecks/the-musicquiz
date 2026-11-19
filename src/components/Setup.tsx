import { useState } from 'react';
import type { SpotifyProfile } from '../spotify/api';
import { getClientId, redirectUri, setClientId } from '../spotify/auth';
import type { PlaybackKind } from '../spotify/playback';

export interface SetupValues {
  players: string[];
  targetCards: number;
  mode: PlaybackKind;
}

interface Props {
  authChecked: boolean;
  profile: SpotifyProfile | null;
  authMessage: string | null;
  initialMode: PlaybackKind;
  deckSize: { all: number; noLogin: number };
  onLogin: () => void;
  onLogout: () => void;
  onStart: (values: SetupValues) => void;
}

const PLAYERS_KEY = 'mq.players';
const TARGET_KEY = 'mq.target';

function loadPlayers(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYERS_KEY) ?? 'null');
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {
    /* ignore */
  }
  return ['Team 1', 'Team 2'];
}

export function Setup({ authChecked, profile, authMessage, initialMode, deckSize, onLogin, onLogout, onStart }: Props) {
  const [players, setPlayers] = useState<string[]>(loadPlayers);
  const [target, setTarget] = useState<number>(() => Number(localStorage.getItem(TARGET_KEY)) || 10);
  const [mode, setMode] = useState<PlaybackKind>(initialMode);
  const [clientId, setClientIdState] = useState(getClientId);
  const [error, setError] = useState<string | null>(null);

  const isPremium = profile?.product === 'premium';
  // Only the Premium option requires a login. The hidden player works without
  // one, using the songs that have a known Spotify id.
  const needsLogin = mode === 'premium' && !profile;
  const songCount = mode === 'embed' && !profile ? deckSize.noLogin : deckSize.all;
  const names = players.map((p) => p.trim()).filter(Boolean);

  const start = () => {
    if (names.length === 0) return setError('Add at least one player or team.');
    if (needsLogin) return setError('Log in with Spotify first, or choose the hidden Spotify player.');
    localStorage.setItem(PLAYERS_KEY, JSON.stringify(names));
    localStorage.setItem(TARGET_KEY, String(target));
    onStart({ players: names, targetCards: target, mode });
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
        <p className="hint">You'll play with {songCount} songs from the 1950s to today.</p>
      </section>

      <section className="panel">
        <h2>How should the music play?</h2>
        <div className="mode-options" role="radiogroup" aria-label="How should the music play?">
          <ModeOption
            value="premium"
            current={mode}
            onSelect={setMode}
            title="Log in with Spotify"
            detail={`Full songs played right here, from all ${deckSize.all} songs. Needs Spotify Premium.`}
          />
          <ModeOption
            value="embed"
            current={mode}
            onSelect={setMode}
            title="Hidden Spotify player, no login"
            detail={`A covered-up Spotify player, ${deckSize.noLogin} songs. Full songs if this browser is signed in to Spotify, otherwise 30-second previews.`}
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
                <button className="spotify" disabled={!clientId.trim()} onClick={onLogin}>
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

function ModeOption(props: { value: PlaybackKind; current: PlaybackKind; onSelect: (v: PlaybackKind) => void; title: string; detail: string }) {
  const selected = props.value === props.current;
  return (
    <button role="radio" aria-checked={selected} className={`mode ${selected ? 'selected' : ''}`} onClick={() => props.onSelect(props.value)}>
      <strong>{props.title}</strong>
      <span>{props.detail}</span>
    </button>
  );
}
