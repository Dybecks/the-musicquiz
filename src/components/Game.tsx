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
import { SpotifyLog } from './SpotifyLog';
import { createSonosPlayback } from '../sonos/playback';
import { createSpotifyConnectPlayback } from '../spotify/remote';
import { sameSpeaker, speakerKey, speakerLabel, type SpeakerChoice } from '../speakers';
import { msg, useLang, useT } from '../i18n';
import { SongNotFoundError } from '../spotify/playback';

interface Props {
  state: GameState;
  mode: PlaybackKind;
  onModeChange: (mode: PlaybackKind) => void;
  /** Where the music plays instead of this device: a Spotify Connect device, the Spotify app, or a Sonos. */
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
          setNote(msg().game.refillFallback(e.message));
          onChange(addSongs(latest.current, builtInForGenres(plan.genres, plan.from, plan.to), undefined));
        } else {
          setNote(msg().game.refillFailed(message(e)));
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
  const t = useT();
  const tg = t.game;
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
  /** The song isn't on Spotify: another speaker won't help, skipping will. */
  const [songMissing, setSongMissing] = useState(false);
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
        : remote?.kind === 'spotify-device' || remote?.kind === 'spotify-app'
          ? Promise.resolve(createSpotifyConnectPlayback(remote.kind === 'spotify-device' ? remote.device : null))
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
    setSongMissing(false);
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
        setSongMissing(e instanceof SongNotFoundError);
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
  const hidden = state.phase === 'guessing' && mode !== 'none' && !!playback && playback.kind !== 'sonos' && playback.kind !== 'spotify-connect' && songStatus === 'ready';
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
    const remoteKind = p.kind === 'sonos' || p.kind === 'spotify-connect';
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
    if (state.phase === 'finished' || window.confirm(tg.confirmEnd)) {
      void playback?.stop();
      // Phones that joined are sent back to their start screen right away.
      if (host.room) host.stop('ended');
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
      ? (({ yes, needed }) => tg.phonesWantNext(yes, needed))(nextVotes(host.room!.members, turnOf(state)))
      : rule === 'anyone'
        ? tg.anyoneMovesOn
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
                <span className="muted">{tg.turnSuffix(player.name)}</span>
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
                          ? tg.playerUnavailable
                          : !playback
                            ? tg.startingPlayer
                            : songStatus === 'loading'
                              ? tg.findingSong
                              : starting
                                ? tg.oneMoment
                                : playing
                                ? tg.pause
                                : tg.play}
                      </button>
                    )}
                    {mode === 'none' && <p className="hint">{tg.noAudio}</p>}
                    <button className="ghost" onClick={skip}>
                      {tg.skip}
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
                        {tg.openInSpotify}
                      </a>{' '}
                      {tg.openInSpotifyHint}
                    </p>
                  )}
                  {playbackError && (
                    <div className="warn">
                      <p>{playbackError}</p>
                      {mode === 'premium' && (
                        <button className="link" onClick={() => onModeChange('embed')}>
                          {tg.useHiddenPlayer}
                        </button>
                      )}
                    </div>
                  )}
                  {songError && <p className="warn">{songError}</p>}
                  {remote && (playbackError || (songError && !songMissing)) && songStatus !== 'loading' && (
                    <p>
                      {songStatus === 'error' && (
                        <>
                          <button className="link" onClick={() => setAttempt((n) => n + 1)}>
                            {tg.tryAgain}
                          </button>{' '}
                          ·{' '}
                        </>
                      )}
                      {remote.kind !== 'sonos' && (
                        <>
                          {/* Opens (wakes) the Spotify app without showing the song. */}
                          <a className="link" href="spotify:">
                            {tg.openApp}
                          </a>{' '}
                          ·{' '}
                        </>
                      )}
                      <button className="link" onClick={() => onSpeakerChange(null)}>
                        {tg.playHere}
                      </button>
                    </p>
                  )}
                  {remote && !playbackError && !songError && (
                    <p className="hint">
                      {remote.kind === 'sonos'
                        ? tg.playingOnSonos(remote.speaker.name)
                        : remote.kind === 'spotify-device'
                          ? tg.playingOnDevice(remote.device.name)
                          : tg.playingInApp}
                    </p>
                  )}
                  {(playback?.kind === 'spotify-connect' || playback?.kind === 'premium') && <SpotifyLog />}
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
                      {tg.lockedTapToChange}
                    </button>
                  ) : (
                    <button
                      className="primary big"
                      disabled={hostMember.vote === null}
                      onClick={() => host.act({ type: 'lock', locked: true })}
                    >
                      {hostMember.vote === null ? tg.tapToVote : tg.lockMyVote}
                    </button>
                  )}
                  {host.decision.kind === 'waiting' && (
                    <p className="hint center vote-status">
                      {tg.teamLocked(host.decision.locked, host.decision.total)}
                    </p>
                  )}
                  {host.decision.kind === 'split' && (
                    <p className="warn center vote-status">{tg.split}</p>
                  )}
                </>
              ) : state.phase === 'guessing' ? (
                <>
                  <button className="primary big" disabled={selectedSlot === null} onClick={lockIn}>
                    {selectedSlot === null
                      ? host.decision.kind === 'none'
                        ? tg.pickSpot
                        : tg.waitingVotes
                      : tg.lockGuess}
                  </button>
                  {host.decision.kind === 'waiting' && (
                    <p className="hint center vote-status">
                      {tg.phonesLocked(host.decision.locked, host.decision.total)}
                    </p>
                  )}
                  {host.decision.kind === 'split' && (
                    <p className="warn center vote-status">{tg.split}</p>
                  )}
                </>
              ) : (
                <>
                  <button className="primary big" onClick={next}>
                    {state.winnerIds.length ? tg.seeWinner : tg.next(nextPlayer.name)}
                  </button>
                  {nextStatus && <p className="hint center vote-status">{nextStatus}</p>}
                </>
              )}
            </div>
          </div>

          <section className="panel board-timeline">
            <h2>
              {tg.timeline(player.name)}{' '}
              <span className="muted">
                ({player.timeline.length}/{state.targetCards})
              </span>
            </h2>
            {state.phase === 'guessing' ? (
              <p className="hint">
                {hostVoting
                  ? tg.hintVote
                  : host.decision.kind === 'none'
                    ? tg.hintTap
                    : tg.hintPhones}
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
          <span>{tg.playerHidden}</span>
          <button className="link" onClick={() => setShowPlayer(true)}>
            {tg.showPlayer}
          </button>
        </div>
        <div ref={embedHost} className="embed-host" />
      </section>

      {refillNote && <p className="hint center">{refillNote}</p>}
      <footer className="game-footer">
        <span className="muted">
          {tg.round(state.round)} · {state.refill ? tg.moreOnTheWay : tg.songsLeft(state.deck.length)}
        </span>
        {mode !== 'none' && (
          <button className="link" onClick={() => setPickSpeaker(!pickSpeaker)}>
            🔊 {speakerLabel(remote)}
          </button>
        )}
        <button className="link" onClick={quit}>
          {tg.endGame}
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
  const t = useT();
  return (
    <div className={`reveal ${correct ? 'right' : 'wrong'}`}>
      <p className="verdict">{correct ? t.game.correct : t.game.wrong}</p>
      <div className="song-card big-card">
        <span className="year">{song.year}</span>
        <span className="title">{song.title}</span>
        <span className="artist">
          {song.artist}
          {song.from && <span className="from">{t.game.fromWork(song.from)}</span>}
        </span>
      </div>
      <FunFact song={song} />
    </div>
  );
}

/** A fun fact about the song (written for its deck, or from Wikipedia). Shows nothing until found, or if none is. */
function FunFact({ song }: { song: GameState['deck'][number] }) {
  const t = useT();
  const lang = useLang();
  const [fact, setFact] = useState<{ id: string; lang: string; fact: SongFact | null } | null>(null);
  useEffect(() => {
    let live = true;
    loadFact(song).then((f) => live && setFact({ id: song.id, lang, fact: f }));
    return () => {
      live = false;
    };
  }, [song, lang]);
  if (!fact || fact.id !== song.id || fact.lang !== lang || !fact.fact) return null;
  const { text, about, title, url } = fact.fact;
  return (
    <aside className="fun-fact">
      <p className="fun-fact-label">{!url ? t.game.didYouKnow : about === 'song' ? t.game.aboutSong : t.game.aboutArtist}</p>
      <p>{text}</p>
      {url && (
        <a href={url} target="_blank" rel="noreferrer">
          {t.game.onWikipedia(title ?? '')}
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
  const t = useT();
  const winners = state.players.filter((p) => state.winnerIds.includes(p.id));
  return (
    <section className="panel finished">
      <h1>{t.game.wins(winners.map((w) => w.name))}</h1>
      {state.players.map((p) => (
        <div key={p.id} className="final-timeline">
          <h2>
            {p.name} <span className="muted">{t.game.cards(p.timeline.length)}</span>
          </h2>
          <Timeline cards={p.timeline} selectable={false} selectedSlot={null} onSelect={() => {}} compact />
        </div>
      ))}
      {onPlayAgain && (
        <button className="primary big" onClick={onPlayAgain}>
          {t.game.playAgain}
        </button>
      )}
    </section>
  );
}
