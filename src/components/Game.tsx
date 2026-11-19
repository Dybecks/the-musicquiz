import { useEffect, useRef, useState } from 'react';
import { currentPlayer, nextTurn, placeCurrent, skipSong, type GameState } from '../game/engine';
import {
  createEmbedPlayback,
  createPremiumPlayback,
  createSilentPlayback,
  type Playback,
  type PlaybackKind,
} from '../spotify/playback';
import { Timeline } from './Timeline';

interface Props {
  state: GameState;
  mode: PlaybackKind;
  onModeChange: (mode: PlaybackKind) => void;
  onChange: (state: GameState) => void;
  onQuit: () => void;
}

type SongStatus = 'loading' | 'ready' | 'error';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Game({ state, mode, onModeChange, onChange, onQuit }: Props) {
  const embedHost = useRef<HTMLDivElement>(null);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [songStatus, setSongStatus] = useState<SongStatus>('loading');
  const [songError, setSongError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [showPlayer, setShowPlayer] = useState(false);

  // Create the player for the chosen mode.
  useEffect(() => {
    let cancelled = false;
    let created: Playback | null = null;
    setPlayback(null);
    setPlaybackError(null);
    const make =
      mode === 'premium'
        ? createPremiumPlayback()
        : mode === 'embed'
          ? createEmbedPlayback(embedHost.current!)
          : Promise.resolve(createSilentPlayback());
    make
      .then((p) => {
        if (cancelled) return p.destroy();
        created = p;
        p.onStateChange(setPlaying);
        setPlayback(p);
      })
      .catch((e) => !cancelled && setPlaybackError(message(e)));
    return () => {
      cancelled = true;
      created?.destroy();
    };
  }, [mode]);

  // Load each new song as it is drawn.
  const songId = state.phase === 'guessing' ? state.current?.id : undefined;
  useEffect(() => {
    if (!playback || !songId || !state.current) return;
    let cancelled = false;
    setSongStatus('loading');
    setSongError(null);
    setPlaying(false);
    setShowPlayer(false);
    playback
      .prepare(state.current)
      .then(() => !cancelled && setSongStatus('ready'))
      .catch((e) => {
        if (cancelled) return;
        setSongStatus('error');
        setSongError(message(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback, songId]);

  const player = currentPlayer(state);

  const togglePlay = async () => {
    if (!playback) return;
    try {
      if (playing) await playback.pause();
      else await playback.play();
      if (playback.kind === 'none') setPlaying(!playing);
    } catch (e) {
      setSongError(message(e));
    }
  };

  const lockIn = () => {
    if (selectedSlot === null) return;
    onChange(placeCurrent(state, selectedSlot));
    setSelectedSlot(null);
  };

  const next = () => {
    void playback?.stop();
    setPlaying(false);
    onChange(nextTurn(state));
  };

  const skip = () => {
    void playback?.stop();
    setSelectedSlot(null);
    onChange(skipSong(state));
  };

  const quit = () => {
    if (state.phase === 'finished' || window.confirm('End this game? Progress will be lost.')) {
      void playback?.stop();
      onQuit();
    }
  };

  const nextPlayer = state.players[(state.currentPlayerIndex + 1) % state.players.length];

  return (
    <main className="game">
      <Scoreboard state={state} />

      {state.phase === 'finished' ? (
        <Finished state={state} onPlayAgain={onQuit} />
      ) : (
        <>
          <section className="panel turn">
            <h1>
              {player.name}
              <span className="muted">’s turn</span>
            </h1>

            {state.phase === 'guessing' ? (
              <div className="mystery">
                <div className={`vinyl ${playing ? 'spinning' : ''}`} aria-hidden>
                  ?
                </div>
                <div className="mystery-actions">
                  {mode !== 'none' && (
                    <button className="primary" onClick={togglePlay} disabled={!playback || songStatus !== 'ready'}>
                      {playbackError
                        ? 'Player unavailable'
                        : !playback
                          ? 'Starting player…'
                          : songStatus === 'loading'
                            ? 'Finding song…'
                            : playing
                              ? '❚❚ Pause'
                              : '▶ Play song'}
                    </button>
                  )}
                  {mode === 'none' && <p className="hint">No audio mode: play the song your own way, or just guess the year.</p>}
                  <button className="ghost" onClick={skip}>
                    Skip song
                  </button>
                </div>
                {playbackError && (
                  <div className="warn">
                    <p>{playbackError}</p>
                    {mode === 'premium' && (
                      <button className="link" onClick={() => onModeChange('embed')}>
                        Use the hidden Spotify player instead
                      </button>
                    )}
                  </div>
                )}
                {songError && <p className="warn">{songError}</p>}
              </div>
            ) : (
              state.lastGuess && <Reveal correct={state.lastGuess.correct} song={state.lastGuess.song} />
            )}
          </section>

          <section className="panel">
            <h2>
              {player.name}’s timeline{' '}
              <span className="muted">
                ({player.timeline.length}/{state.targetCards})
              </span>
            </h2>
            {state.phase === 'guessing' ? (
              <p className="hint">Tap where the song belongs, then lock in your guess.</p>
            ) : null}
            <Timeline
              cards={player.timeline}
              selectable={state.phase === 'guessing'}
              selectedSlot={selectedSlot}
              onSelect={setSelectedSlot}
              highlightId={state.phase === 'revealed' && state.lastGuess?.correct ? state.lastGuess.song.id : undefined}
              wrongCard={state.phase === 'revealed' && state.lastGuess && !state.lastGuess.correct ? state.lastGuess.song : undefined}
            />
          </section>

          <div className="action-bar">
            {state.phase === 'guessing' ? (
              <button className="primary big" disabled={selectedSlot === null} onClick={lockIn}>
                Lock in guess
              </button>
            ) : (
              <button className="primary big" onClick={next}>
                {state.winnerIds.length ? 'See the winner' : `Next: ${nextPlayer.name}`}
              </button>
            )}
          </div>
        </>
      )}

      {/* The Spotify embed lives here. It stays covered so the title isn't spoiled. */}
      <section className={`embed-wrap ${mode === 'embed' && state.phase !== 'finished' ? '' : 'hidden'}`}>
        <div className={`embed-cover ${showPlayer || state.phase === 'revealed' ? 'off' : ''}`}>
          <span>Spotify player hidden so the song isn’t spoiled.</span>
          <button className="link" onClick={() => setShowPlayer(true)}>
            Show it (if the Play button doesn’t work)
          </button>
        </div>
        <div ref={embedHost} className="embed-host" />
      </section>

      <footer className="game-footer">
        <span className="muted">
          Round {state.round} · {state.deck.length} songs left
        </span>
        <button className="link" onClick={quit}>
          End game
        </button>
      </footer>
    </main>
  );
}

function Scoreboard({ state }: { state: GameState }) {
  return (
    <ol className="scoreboard">
      {state.players.map((p, i) => (
        <li key={p.id} className={i === state.currentPlayerIndex && state.phase !== 'finished' ? 'active' : ''}>
          <span className="name">{p.name}</span>
          <span className="count">
            {p.timeline.length}
            <span className="muted">/{state.targetCards}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function Reveal({ correct, song }: { correct: boolean; song: GameState['deck'][number] }) {
  return (
    <div className={`reveal ${correct ? 'right' : 'wrong'}`}>
      <p className="verdict">{correct ? 'Correct! The card is yours.' : 'Not quite. The card is discarded.'}</p>
      <div className="song-card big-card">
        <span className="year">{song.year}</span>
        <span className="title">{song.title}</span>
        <span className="artist">
          {song.artist}
          {song.from && <span className="from"> · from {song.from}</span>}
        </span>
      </div>
    </div>
  );
}

function Finished({ state, onPlayAgain }: { state: GameState; onPlayAgain: () => void }) {
  const winners = state.players.filter((p) => state.winnerIds.includes(p.id));
  return (
    <section className="panel finished">
      <h1>🏆 {winners.map((w) => w.name).join(' & ')} {winners.length > 1 ? 'win' : 'wins'}!</h1>
      {state.players.map((p) => (
        <div key={p.id} className="final-timeline">
          <h2>
            {p.name} <span className="muted">({p.timeline.length} cards)</span>
          </h2>
          <Timeline cards={p.timeline} selectable={false} selectedSlot={null} onSelect={() => {}} compact />
        </div>
      ))}
      <button className="primary big" onClick={onPlayAgain}>
        Play again
      </button>
    </section>
  );
}
