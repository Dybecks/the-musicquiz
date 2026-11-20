import { useEffect, useRef, useState } from 'react';
import { addSongs, currentPlayer, nextTurn, placeCurrent, skipSong, type GameState } from '../game/engine';
import { builtInForGenres, fetchBatch, type RefillPlan } from '../spotify/listening';
import { RateLimitError, findTrackUri } from '../spotify/api';
import {
  createEmbedPlayback,
  createPremiumPlayback,
  createSilentPlayback,
  type Playback,
  type PlaybackKind,
} from '../spotify/playback';
import { hideNowPlaying, primeNowPlaying, showNowPlaying, unprimeNowPlaying } from '../spotify/nowPlaying';
import { loadFact, type SongFact } from '../facts';
import { Timeline } from './Timeline';
import type { HostRoom } from '../multiplayer/useHostRoom';
import { HOST_ID, activeVoters, nextRuleOf, nextVotes, turnOf, votesBySlot } from '../multiplayer/protocol';
import { SharePanel } from './SharePanel';
import { SpeakerPicker } from './SpeakerPicker';
import { createSonosPlayback } from '../sonos/playback';
import { createSpotifyAppPlayback } from '../spotify/remote';
import { sameSpeaker, speakerKey, speakerLabel, type SpeakerChoice } from '../speakers';

interface Props {
  state: GameState;
  mode: PlaybackKind;
  onModeChange: (mode: PlaybackKind) => void;
  /** Where the music plays instead of this device: the Spotify app, or a Sonos. */
  speaker: SpeakerChoice | null;
  onSpeakerChange: (choice: SpeakerChoice | null) => void;
  onChange: (state: GameState) => void;
  onQuit: () => void;
  /** Phones following the game (see useHostRoom). */
  host: HostRoom;
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

export function Game({ state, mode, onModeChange, speaker, onSpeakerChange, onChange, onQuit, host }: Props) {
  const refillNote = useRefill(state, onChange);
  const votes = host.room && state.phase === 'guessing' ? votesBySlot(activeVoters(host.room, state)) : undefined;
  // The host on the team whose turn it is votes like everyone else on it.
  const hostMember = host.room?.members.find((m) => m.id === HOST_ID);
  const hostVoting = !!hostMember && state.phase === 'guessing' && hostMember.teamId === currentPlayer(state).id;
  const embedHost = useRef<HTMLDivElement>(null);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [songStatus, setSongStatus] = useState<SongStatus>('loading');
  const [songError, setSongError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [showPlayer, setShowPlayer] = useState(false);
  const [pickSpeaker, setPickSpeaker] = useState(false);
  /** Play was tapped and the player hasn't answered yet (a Sonos can take a moment). */
  const [starting, setStarting] = useState(false);
  /** Bumped by "Try again" to load the song again. */
  const [attempt, setAttempt] = useState(0);
  // No audio mode plays nothing, so there's no speaker to choose.
  const remote = mode !== 'none' ? speaker : null;

  // Create the player for the chosen mode.
  useEffect(() => {
    let cancelled = false;
    let created: Playback | null = null;
    setPlayback(null);
    setPlaybackError(null);
    const make =
      remote?.kind === 'sonos'
        ? Promise.resolve(createSonosPlayback(remote))
        : remote?.kind === 'spotify-app'
          ? Promise.resolve(createSpotifyAppPlayback())
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, speakerKey(remote)]);

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
      .then(() => {
        if (cancelled) return;
        setSongStatus('ready');
        void autoStart(playback);
      })
      .catch((e) => {
        if (cancelled) return;
        setSongStatus('error');
        setSongError(message(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback, songId, attempt]);

  // A link that opens the song in the Spotify app, to play it on any speaker
  // the app can reach. Songs found by search reuse the lookup the player made.
  const [spotifyUrl, setSpotifyUrl] = useState<string | null>(null);
  useEffect(() => {
    setSpotifyUrl(null);
    const song = state.current;
    if (!song || state.phase !== 'guessing') return;
    let cancelled = false;
    const toUrl = (uri: string | null) => uri && `https://open.spotify.com/track/${uri.split(':').pop()}`;
    if (song.spotifyId) setSpotifyUrl(toUrl(`spotify:track:${song.spotifyId}`));
    else if (songStatus === 'ready' && mode !== 'none')
      void findTrackUri(song)
        .then((uri) => !cancelled && setSpotifyUrl(toUrl(uri)))
        .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId, songStatus]);

  // Report "Mystery song" to lock screens and AirPlay/Bluetooth receivers while
  // the song is hidden; their play/pause buttons still control the real song.
  const playbackRef = useRef<Playback | null>(null);
  playbackRef.current = playback;
  const hidden = state.phase === 'guessing' && mode !== 'none' && !!playback && playback.kind !== 'sonos' && playback.kind !== 'spotify-app' && songStatus === 'ready';
  useEffect(() => {
    if (!hidden) return showNowPlaying();
    hideNowPlaying(playing, {
      play: () => void playbackRef.current?.play().catch(() => {}),
      pause: () => void playbackRef.current?.pause().catch(() => {}),
    });
  }, [hidden, playing, songId]);
  useEffect(() => () => showNowPlaying(), []);

  // Look up the fun fact while the song plays, so it's ready at the reveal.
  useEffect(() => {
    if (songId && state.current) void loadFact(state.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId]);

  const player = currentPlayer(state);

  /**
   * Start each new song by itself once it is loaded. Not right after the page
   * was (re)loaded: browsers only allow sound once someone has tapped the page.
   * In this browser a refused start just leaves the Play button; on a speaker
   * or the Spotify app the reason is shown.
   */
  const autoStart = async (p: Playback) => {
    if (p.kind === 'none') return;
    const tapped = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? true;
    if (!tapped) return;
    const remoteKind = p.kind === 'sonos' || p.kind === 'spotify-app';
    setStarting(true);
    try {
      await p.play();
    } catch (e) {
      if (remoteKind) setSongError(message(e));
    } finally {
      setStarting(false);
    }
  };

  /** `fromPhone`: asked for by a phone, so not inside a tap on this screen. */
  const togglePlay = async (fromPhone = false) => {
    if (!playback) return;
    // Start the silent cover inside the click: Safari won't start it later.
    const priming = !playing && hidden && !fromPhone;
    if (priming) primeNowPlaying();
    setStarting(true);
    try {
      if (playing) await playback.pause();
      else await playback.play();
      if (playback.kind === 'none') setPlaying(!playing);
      setSongError(null);
    } catch (e) {
      if (priming) unprimeNowPlaying();
      setSongError(message(e));
    } finally {
      setStarting(false);
    }
  };

  // Tell the phones what happens here: the song playing, and the spot tapped.
  const { setLive } = host;
  useEffect(() => {
    setLive({ playing: state.phase === 'guessing' && playing, hostPick: state.phase === 'guessing' && !hostVoting ? selectedSlot : null });
  }, [setLive, playing, selectedSlot, hostVoting, state.phase]);
  useEffect(() => () => setLive({ playing: false, hostPick: null }), [setLive]);

  // A new turn starts with nothing picked.
  const turn = `${state.round}:${state.currentPlayerIndex}:${state.current?.id ?? ''}`;
  useEffect(() => setSelectedSlot(null), [turn]);

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

  // What the phones ask for: the next song after the reveal, play and pause.
  const commands = useRef({ state, playing, ready: false, next, togglePlay });
  commands.current = { state, playing, ready: !!playback && songStatus === 'ready' && !starting, next, togglePlay };
  const { onCommand } = host;
  useEffect(
    () =>
      onCommand((cmd) => {
        const c = commands.current;
        if (cmd.type === 'next') {
          if (c.state.phase === 'revealed' && cmd.turn === turnOf(c.state)) c.next();
        } else if (c.state.phase === 'guessing' && mode !== 'none' && c.ready && cmd.playing !== c.playing) {
          void c.togglePlay(true);
        }
      }),
    [onCommand, mode],
  );

  const skip = () => {
    void playback?.stop();
    setPlaying(false);
    setSelectedSlot(null);
    onChange(skipSong(state));
  };

  const quit = () => {
    if (state.phase === 'finished' || window.confirm('End this game? Progress will be lost.')) {
      void playback?.stop();
      // Phones that joined are sent back to their start screen right away.
      if (host.room) host.stop('The host ended the game.');
      onQuit();
    }
  };

  const nextPlayer = state.players[(state.currentPlayerIndex + 1) % state.players.length];
  // With phones in the room: who else can move on.
  const phones = host.room?.members.filter((m) => m.id !== HOST_ID && m.connected).length ?? 0;
  const rule = nextRuleOf(host.room);
  const nextStatus = !phones
    ? null
    : rule === 'majority'
      ? (({ yes, needed }) => `Phones: ${yes} of ${needed} needed want the next song`)(nextVotes(host.room!.members, turnOf(state)))
      : rule === 'anyone'
        ? 'Any player can move on from their phone.'
        : null;

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
                      <button className="primary" onClick={() => void togglePlay()} disabled={!playback || songStatus !== 'ready' || starting}>
                        {playbackError
                          ? 'Player unavailable'
                          : !playback
                            ? 'Starting player…'
                            : songStatus === 'loading'
                              ? 'Finding song…'
                              : starting
                                ? 'One moment…'
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
                  {spotifyUrl && !remote && (
                    <p className="hint open-spotify">
                      <a
                        href={spotifyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => {
                          if (playing) void playback?.pause().catch(() => {});
                        }}
                      >
                        Open in Spotify ↗
                      </a>{' '}
                      to play it on any speaker, like a Sonos. Spotify shows the title, so let someone who isn’t guessing tap it.
                    </p>
                  )}
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
                  {remote && (playbackError || (songError && !/found on Spotify/.test(songError))) && songStatus !== 'loading' && (
                    <p>
                      {songStatus === 'error' && (
                        <>
                          <button className="link" onClick={() => setAttempt((n) => n + 1)}>
                            Try again
                          </button>{' '}
                          ·{' '}
                        </>
                      )}
                      {remote.kind === 'spotify-app' && (
                        <>
                          {/* Opens (wakes) the Spotify app without showing the song. */}
                          <a className="link" href="spotify:">
                            Open the Spotify app
                          </a>{' '}
                          ·{' '}
                        </>
                      )}
                      <button className="link" onClick={() => onSpeakerChange(null)}>
                        Play on this device instead
                      </button>
                    </p>
                  )}
                  {remote && !playbackError && !songError && (
                    <p className="hint">
                      {remote.kind === 'sonos'
                        ? `Playing on ${remote.speaker.name} (Sonos).`
                        : 'Playing in the Spotify app, wherever it plays. It shows the title, so keep it out of sight.'}
                    </p>
                  )}
                </div>
              ) : (
                state.lastGuess && <Reveal correct={state.lastGuess.correct} song={state.lastGuess.song} />
              )}
            </section>

            <div className="action-bar">
              {state.phase === 'guessing' && hostVoting ? (
                <>
                  {hostMember.locked ? (
                    <button className="ghost big" onClick={() => host.act({ type: 'lock', locked: false })}>
                      Locked in · tap to change
                    </button>
                  ) : (
                    <button
                      className="primary big"
                      disabled={hostMember.vote === null}
                      onClick={() => host.act({ type: 'lock', locked: true })}
                    >
                      {hostMember.vote === null ? 'Tap a spot to vote' : 'Lock in my vote'}
                    </button>
                  )}
                  {host.decision.kind === 'waiting' && (
                    <p className="hint center vote-status">
                      Team: {host.decision.locked} of {host.decision.total} locked in
                    </p>
                  )}
                  {host.decision.kind === 'split' && (
                    <p className="warn center vote-status">The votes are split. Agree on one spot and lock in again.</p>
                  )}
                </>
              ) : state.phase === 'guessing' ? (
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
                <>
                  <button className="primary big" onClick={next}>
                    {state.winnerIds.length ? 'See the winner' : `Next: ${nextPlayer.name}`}
                  </button>
                  {nextStatus && <p className="hint center vote-status">{nextStatus}</p>}
                </>
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
                {hostVoting
                  ? 'Vote for where the song belongs. The guess goes in when everyone on the team has locked in.'
                  : host.decision.kind === 'none'
                    ? 'Tap where the song belongs, then lock in your guess.'
                    : 'The team votes on their phones. Tap a spot here to decide for them.'}
              </p>
            ) : null}
            <Timeline
              cards={player.timeline}
              selectable={state.phase === 'guessing'}
              selectedSlot={hostVoting ? hostMember.vote : selectedSlot}
              onSelect={(slot) =>
                hostVoting
                  ? host.act({ type: 'vote', slot: slot === hostMember.vote ? null : slot })
                  : setSelectedSlot(slot)
              }
              highlightId={state.phase === 'revealed' && state.lastGuess?.correct ? state.lastGuess.song.id : undefined}
              wrongCard={state.phase === 'revealed' && state.lastGuess && !state.lastGuess.correct ? state.lastGuess.song : undefined}
              votes={votes}
            />
          </section>
        </div>
      )}

      {state.phase !== 'finished' && <SharePanel host={host} />}

      {/* The Spotify embed lives here. It stays covered so the title isn't spoiled. */}
      <section className={`embed-wrap ${mode === 'embed' && !remote && state.phase !== 'finished' ? '' : 'hidden'}`}>
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
        {mode !== 'none' && (
          <button className="link" onClick={() => setPickSpeaker(!pickSpeaker)}>
            🔊 {speakerLabel(remote)}
          </button>
        )}
        <button className="link" onClick={quit}>
          End game
        </button>
      </footer>
      {pickSpeaker && mode !== 'none' && (
        <section className="panel">
          <SpeakerPicker
            choice={speaker}
            onChange={(c) => {
              setPickSpeaker(false);
              if (sameSpeaker(c, speaker)) return;
              // The player for the new choice is made fresh (and loads the song again).
              setPlaying(false);
              onSpeakerChange(c);
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
