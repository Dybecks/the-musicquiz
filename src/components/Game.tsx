import { useEffect, useRef, useState } from 'react';
import { addSongs, currentPlayer, nextTurn, placeCurrent, skipSong, type GameState } from '../game/engine';
import { builtInForGenres, fetchBatch, type RefillPlan } from '../spotify/listening';
import { RateLimitError } from '../spotify/api';
import {
  createEmbedPlayback,
  createPremiumPlayback,
  createSilentPlayback,
  createSpeakerPlayback,
  type Playback,
  type Speaker,
  type PlaybackKind,
} from '../spotify/playback';
import { loadFact, type SongFact } from '../facts';
import { Timeline } from './Timeline';
import { useHostRoom, type HostRoom } from '../multiplayer/useHostRoom';
import { activeVoters, votesBySlot } from '../multiplayer/protocol';
import { SpeakerPicker } from './SpeakerPicker';

interface Props {
  state: GameState;
  mode: PlaybackKind;
  onModeChange: (mode: PlaybackKind) => void;
  /** A Spotify Connect speaker to play on (Premium), instead of this browser. */
  speaker: Speaker | null;
  onSpeakerChange: (speaker: Speaker | null) => void;
  onChange: (state: GameState) => void;
  onQuit: () => void;
}

type SongStatus = 'loading' | 'ready' | 'error';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Fetch more songs when this few are left in the deck. */
const REFILL_AT = 4;

/**
 * Keeps the deck topped up for lists that are fetched a few songs at a
 * time: when it runs low, one more batch (one request) is fetched in the
 * background. If Spotify's request limit is used up, a genre list carries on
 * with the game's own songs for its genres and years.
 */
function useRefill(state: GameState, onChange: (s: GameState) => void): string | null {
  const latest = useRef(state);
  latest.current = state;
  const busy = useRef(false);
  const [note, setNote] = useState<string | null>(null);
  const plan = state.refill as RefillPlan | undefined;
  const low = !!plan && state.phase !== 'finished' && state.deck.length <= REFILL_AT;

  useEffect(() => {
    if (!low || !plan || busy.current) return;
    busy.current = true;
    fetchBatch(plan)
      .then(({ songs, plan: next }) => onChange(addSongs(latest.current, songs, next ?? undefined)))
      .catch((e) => {
        if (e instanceof RateLimitError && plan.kind === 'genres') {
          setNote(`${e.message} Until then the game uses its own classic hits for these genres and years.`);
          onChange(addSongs(latest.current, builtInForGenres(plan.genres, plan.from, plan.to), undefined));
        } else {
          setNote(`No more songs could be fetched: ${message(e)}`);
          onChange({ ...latest.current, refill: undefined });
        }
      })
      .finally(() => {
        busy.current = false;
      });
    // Runs again whenever the deck shrinks or the plan changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [low, state.deck.length, plan]);

  return note;
}

export function Game({ state, mode, onModeChange, speaker, onSpeakerChange, onChange, onQuit: quitGame }: Props) {
  const refillNote = useRefill(state, onChange);
  const host = useHostRoom(state, onChange);
  const onQuit = () => {
    host.stop();
    quitGame();
  };
  const votes = host.room && state.phase === 'guessing' ? votesBySlot(activeVoters(host.room, state)) : undefined;
  const embedHost = useRef<HTMLDivElement>(null);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [songStatus, setSongStatus] = useState<SongStatus>('loading');
  const [songError, setSongError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [showPlayer, setShowPlayer] = useState(false);
  const [pickSpeaker, setPickSpeaker] = useState(false);

  // Create the player for the chosen mode.
  useEffect(() => {
    let cancelled = false;
    let created: Playback | null = null;
    setPlayback(null);
    setPlaybackError(null);
    const make =
      mode === 'premium' && speaker
        ? Promise.resolve(createSpeakerPlayback(speaker))
        : mode === 'premium'
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
  }, [mode, speaker?.id]);

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

  // Look up the fun fact while the song plays, so it's ready at the reveal.
  useEffect(() => {
    if (songId && state.current) void loadFact(state.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId]);

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
        <div className="board">
          <div className="board-main">
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
                  {songError && (
                    <div className="warn">
                      <p>{songError}</p>
                      {mode === 'premium' && speaker && songStatus === 'ready' && (
                        <button className="link" onClick={() => onSpeakerChange(null)}>
                          Play in this browser instead
                        </button>
                      )}
                    </div>
                  )}
                  {mode === 'premium' && speaker && !songError && <p className="hint">{speaker.id ? `Playing on ${speaker.name}.` : 'Playing where the Spotify app plays.'}</p>}
                </div>
              ) : (
                state.lastGuess && <Reveal correct={state.lastGuess.correct} song={state.lastGuess.song} />
              )}
            </section>

            <div className="action-bar">
              {state.phase === 'guessing' ? (
                <>
                  <button className="primary big" disabled={selectedSlot === null} onClick={lockIn}>
                    {selectedSlot === null
                      ? host.decision.kind === 'none'
                        ? 'Pick a spot on the timeline'
                        : 'Waiting for the team’s votes'
                      : 'Lock in guess'}
                  </button>
                  {host.decision.kind === 'waiting' && (
                    <p className="hint center vote-status">
                      Phones: {host.decision.locked} of {host.decision.total} locked in
                    </p>
                  )}
                  {host.decision.kind === 'split' && (
                    <p className="warn center vote-status">The votes are split. Agree on one spot and lock in again.</p>
                  )}
                </>
              ) : (
                <button className="primary big" onClick={next}>
                  {state.winnerIds.length ? 'See the winner' : `Next: ${nextPlayer.name}`}
                </button>
              )}
            </div>
          </div>

          <section className="panel board-timeline">
            <h2>
              {player.name}’s timeline{' '}
              <span className="muted">
                ({player.timeline.length}/{state.targetCards})
              </span>
            </h2>
            {state.phase === 'guessing' ? (
              <p className="hint">
                {host.decision.kind === 'none'
                  ? 'Tap where the song belongs, then lock in your guess.'
                  : 'The team votes on their phones. Tap a spot here to decide for them.'}
              </p>
            ) : null}
            <Timeline
              cards={player.timeline}
              selectable={state.phase === 'guessing'}
              selectedSlot={selectedSlot}
              onSelect={setSelectedSlot}
              highlightId={state.phase === 'revealed' && state.lastGuess?.correct ? state.lastGuess.song.id : undefined}
              wrongCard={state.phase === 'revealed' && state.lastGuess && !state.lastGuess.correct ? state.lastGuess.song : undefined}
              votes={votes}
            />
          </section>
        </div>
      )}

      {state.phase !== 'finished' && <SharePanel host={host} state={state} />}

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

      {refillNote && <p className="hint center">{refillNote}</p>}
      <footer className="game-footer">
        <span className="muted">
          Round {state.round} · {state.refill ? 'more songs on the way' : `${state.deck.length} songs left`}
        </span>
        {mode === 'premium' && (
          <button className="link" onClick={() => setPickSpeaker(!pickSpeaker)}>
            🔊 {speaker ? (speaker.id ? speaker.name : 'Spotify app') : 'This browser'}
          </button>
        )}
        <button className="link" onClick={quit}>
          End game
        </button>
      </footer>
      {pickSpeaker && mode === 'premium' && (
        <section className="panel">
          <SpeakerPicker
            speaker={speaker}
            testable={false}
            onChange={(s) => {
              onSpeakerChange(s);
              setPickSpeaker(false);
            }}
          />
        </section>
      )}
    </main>
  );
}

export function Scoreboard({ state }: { state: Pick<GameState, 'players' | 'currentPlayerIndex' | 'phase' | 'targetCards'> }) {
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

export function Reveal({ correct, song }: { correct: boolean; song: GameState['deck'][number] }) {
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
      <FunFact song={song} />
    </div>
  );
}

/** A fun fact about the song (written for its deck, or from Wikipedia). Shows nothing until found, or if none is. */
function FunFact({ song }: { song: GameState['deck'][number] }) {
  const [fact, setFact] = useState<{ id: string; fact: SongFact | null } | null>(null);
  useEffect(() => {
    let live = true;
    loadFact(song).then((f) => live && setFact({ id: song.id, fact: f }));
    return () => {
      live = false;
    };
  }, [song]);
  if (!fact || fact.id !== song.id || !fact.fact) return null;
  const { text, about, title, url } = fact.fact;
  return (
    <aside className="fun-fact">
      <p className="fun-fact-label">{!url ? 'Did you know?' : about === 'song' ? 'About the song' : 'About the artist'}</p>
      <p>{text}</p>
      {url && (
        <a href={url} target="_blank" rel="noreferrer">
          {title} on Wikipedia
        </a>
      )}
    </aside>
  );
}

export function Finished({
  state,
  onPlayAgain,
}: {
  state: Pick<GameState, 'players' | 'winnerIds'>;
  onPlayAgain?: () => void;
}) {
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
      {onPlayAgain && (
        <button className="primary big" onClick={onPlayAgain}>
          Play again
        </button>
      )}
    </section>
  );
}

/** The link a phone opens to join this game. */
export const joinLink = (code: string) => `${new URL(import.meta.env.BASE_URL, window.location.origin)}?join=${code}`;

/** Lets phones join the game: the code, who has joined and which team they are on. */
function SharePanel({ host, state }: { host: HostRoom; state: GameState }) {
  const [copied, setCopied] = useState(false);
  const { room, status } = host;
  if (!room) {
    return (
      <section className="panel share">
        <h2>Play together on phones</h2>
        <p className="hint">
          Share a code so everyone can follow the game on their own phone, join a team and vote for the spot before the
          team locks in together. The music still plays here.
        </p>
        <button className="ghost" onClick={host.share}>
          Share a game code
        </button>
      </section>
    );
  }
  const link = joinLink(room.code);
  const shareLink = async () => {
    const data = { title: 'The Music Quiz', text: `Join the game with code ${room.code}`, url: link };
    try {
      if (navigator.share) await navigator.share(data);
      else {
        await navigator.clipboard.writeText(link);
        setCopied(true);
      }
    } catch {
      // Cancelled, or no clipboard: the code is on screen anyway.
    }
  };
  const unassigned = room.members.filter((m) => !m.teamId || !state.players.some((p) => p.id === m.teamId));
  return (
    <section className="panel share">
      <div className="share-head">
        <div>
          <p className="hint">Game code</p>
          <p className="room-code" aria-label={`Game code ${room.code.split('').join(' ')}`}>
            {room.code}
          </p>
        </div>
        <button className="ghost" onClick={shareLink}>
          {copied ? 'Link copied' : 'Share link'}
        </button>
      </div>
      <p className="hint">
        {status?.kind === 'open'
          ? 'Open the game on a phone, choose “Join a game” and type the code, or open the link.'
          : status?.kind === 'error'
            ? status.message
            : 'Opening the room…'}
      </p>
      <ul className="team-members">
        {state.players.map((p) => {
          const members = room.members.filter((m) => m.teamId === p.id);
          return (
            <li key={p.id}>
              <strong>{p.name}</strong>
              <span>{members.length ? members.map((m) => <MemberName key={m.id} member={m} />) : <span className="muted">no phones</span>}</span>
            </li>
          );
        })}
        {unassigned.length > 0 && (
          <li>
            <strong className="muted">Choosing a team</strong>
            <span>
              {unassigned.map((m) => (
                <MemberName key={m.id} member={m} />
              ))}
            </span>
          </li>
        )}
      </ul>
      <button className="link" onClick={() => host.stop('The host stopped sharing the game.')}>
        Stop sharing
      </button>
    </section>
  );
}

function MemberName({ member }: { member: { name: string; connected: boolean; locked: boolean } }) {
  return (
    <span className={`member ${member.connected ? '' : 'offline'}`} title={member.connected ? undefined : 'Not connected'}>
      {member.name}
      {member.locked && ' ✓'}
    </span>
  );
}
