import { useEffect, useRef, useState } from 'react';
import { addSongs, applyPower, clipMs, currentPlayer, longerClip, modeOf, setBet, startClock, timeUp, usesStars, nextTurn, placeCurrent, scoreOf, skipSong, upNext, waitingForSongs, type GameState, type LastGuess, type Player } from '../game/engine';
import { fetchBatch, type RefillPlan } from '../spotify/listening';
import {
  createEmbedPlayback,
  createPremiumPlayback,
  createSilentPlayback,
  type Playback,
  type PlaybackKind,
} from '../spotify/playback';
import { hideNowPlaying, primeNowPlaying, showNowPlaying, unprimeNowPlaying } from '../spotify/nowPlaying';
import { loadFact, type SongFact } from '../facts';
import { loadArtwork, type Artwork } from '../facts/artwork';
import { Timeline } from './Timeline';
import type { HostRoom } from '../multiplayer/useHostRoom';
import { HOST_ID, gameView, activeVoters, hasQuestion, nextRuleOf, nextVotes, readyToLock, turnOf, votesByAnswer, votesBySlot } from '../multiplayer/protocol';
import { BonusOutcome, BonusQuestion } from './BonusQuestion';
import { PowerUps } from './PowerUps';
import { BetPicker, IntroInfo, SpeedClock } from './TurnExtras';
import { SharePanel } from './SharePanel';
import { msg, useLang, useT } from '../i18n';
import { SongNotFoundError } from '../spotify/playback';
import { PlayerBar, type Clock } from './PlayerBar';

interface Props {
  state: GameState;
  mode: PlaybackKind;
  onModeChange: (mode: PlaybackKind) => void;
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
 * time (playlists): when it runs low, one more batch (one request) is
 * fetched in the background.
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
        setNote(msg().game.refillFailed(message(e)));
        onChange({ ...latest.current, refill: undefined });
      })
      .finally(() => {
        busy.current = false;
      });
    // Runs again whenever the deck shrinks or the plan changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [low, state.deck.length, plan]);

  return note;
}

export function Game({ state, mode, onModeChange, onChange, onQuit, host }: Props) {
  const t = useT();
  const tg = t.game;
  const refillNote = useRefill(state, onChange);
  const voters = host.room && state.phase === 'guessing' ? activeVoters(host.room, state) : null;
  const votes = voters ? votesBySlot(voters) : undefined;
  const answerVotes = voters ? votesByAnswer(voters) : undefined;
  const question = hasQuestion(state) ? state.question! : null;
  // The host on the team whose turn it is votes like everyone else on it.
  const hostMember = host.room?.members.find((m) => m.id === HOST_ID);
  const hostVoting = !!hostMember && state.phase === 'guessing' && hostMember.teamId === currentPlayer(state).id;
  const embedHost = useRef<HTMLDivElement>(null);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [songStatus, setSongStatus] = useState<SongStatus>('loading');
  const [songError, setSongError] = useState<string | null>(null);
  /** The song isn't on Spotify: skipping it helps. */
  const [songMissing, setSongMissing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  /** The answer picked here for the bonus question (mode 'bonus'). */
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  /** The Spotify embed is opened above the bar (it shows the title). */
  const [showPlayer, setShowPlayer] = useState(false);
  const [progress, setProgress] = useState<Clock>(() => ({ positionMs: 0, durationMs: 0, at: performance.now() }));
  /** Play was tapped and the player hasn't answered yet. */
  const [starting, setStarting] = useState(false);
  /** Bumped by "Try again" to load the song again. */
  const [attempt, setAttempt] = useState(0);

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
        p.onProgress((pr) => setProgress({ ...pr, at: performance.now() }));
        setPlayback(p);
      })
      .catch((e) => !cancelled && setPlaybackError(message(e)));
    return () => {
      cancelled = true;
      created?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

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
    setProgress({ positionMs: 0, durationMs: 0, at: performance.now() });
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

  // Report "Mystery song" to lock screens and AirPlay/Bluetooth receivers while
  // the song is hidden; their play/pause buttons still control the real song.
  const playbackRef = useRef<Playback | null>(null);
  playbackRef.current = playback;
  const hidden = state.phase === 'guessing' && mode !== 'none' && !!playback && songStatus === 'ready';
  useEffect(() => {
    if (!hidden) return showNowPlaying();
    hideNowPlaying(playing, {
      play: () => void playbackRef.current?.play().catch(() => {}),
      pause: () => void playbackRef.current?.pause().catch(() => {}),
    });
  }, [hidden, playing, songId]);
  useEffect(() => () => showNowPlaying(), []);

  // Look up the fun fact and the picture while the song plays, so they're ready at the reveal.
  useEffect(() => {
    if (songId && state.current) {
      void loadFact(state.current);
      void loadArtwork(state.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId]);

  const player = currentPlayer(state);

  /**
   * Start each new song by itself once it is loaded. Not right after the page
   * was (re)loaded: browsers only allow sound once someone has tapped the page.
   * A refused start just leaves the Play button.
   */
  const autoStart = async (p: Playback) => {
    if (p.kind === 'none') return;
    const tapped = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? true;
    if (!tapped) return;
    setStarting(true);
    try {
      await p.play();
    } catch {
      /* the Play button is still there */
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
      else {
        // The intro challenge always plays from the start.
        if (intro) await seek(0);
        await playback.play();
      }
      if (playback.kind === 'none') setPlaying(!playing);
      setSongError(null);
    } catch (e) {
      if (priming) unprimeNowPlaying();
      setSongError(message(e));
    } finally {
      setStarting(false);
    }
  };

  const seek = async (ms: number) => {
    if (!playback) return;
    // Show the new spot right away; the player's next report corrects it.
    setProgress((p) => ({ ...p, positionMs: ms, at: performance.now() }));
    try {
      await playback.seek(ms);
    } catch (e) {
      setSongError(message(e));
    }
  };

  // ---- Speed round: the clock starts with the song, and the turn is lost when it runs out.
  const gameMode = modeOf(state);
  const latestState = useRef(state);
  latestState.current = state;
  useEffect(() => {
    if (gameMode === 'speed' && playing && state.phase === 'guessing' && state.deadline === undefined) onChange(startClock(state));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameMode, playing, state.phase, state.deadline]);
  useEffect(() => {
    if (gameMode !== 'speed' || state.phase !== 'guessing' || state.deadline === undefined) return;
    const timer = setTimeout(() => {
      const late = timeUp(latestState.current);
      if (late !== latestState.current) {
        void playback?.pause().catch(() => {});
        onChange(late);
      }
    }, Math.max(0, state.deadline - Date.now()) + 50);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameMode, state.phase, state.deadline]);

  // ---- Intro challenge: only the clip plays, then the song pauses.
  const intro = gameMode === 'intro' && state.phase === 'guessing';
  const clip = clipMs(state);
  useEffect(() => {
    if (!intro || !playing || !playback) return;
    const left = clip - progress.positionMs;
    if (left <= 0) {
      void playback.pause().catch(() => {});
      return;
    }
    const timer = setTimeout(() => void playback.pause().catch(() => {}), left);
    return () => clearTimeout(timer);
  }, [intro, playing, playback, clip, progress.positionMs]);
  const replayIntro = async () => {
    if (!playback) return;
    await seek(0);
    if (!playing) await togglePlay();
  };

  // Tell the phones what happens here: the song playing, and the spot tapped.
  const { setLive } = host;
  useEffect(() => {
    setLive({ playing: state.phase === 'guessing' && playing, hostPick: state.phase === 'guessing' && !hostVoting ? selectedSlot : null });
  }, [setLive, playing, selectedSlot, hostVoting, state.phase]);
  useEffect(() => () => setLive({ playing: false, hostPick: null }), [setLive]);

  // A new turn starts with nothing picked.
  const turn = `${state.round}:${state.currentPlayerIndex}:${state.current?.id ?? ''}:${state.stealing ? 's' : ''}:${state.powers?.missedSlot ?? ''}`;
  useEffect(() => {
    setSelectedSlot(null);
    setSelectedAnswer(null);
  }, [turn]);

  /** Everything the turn asks for is picked here: a spot, and an answer when there is a bonus question. */
  const picked = readyToLock({ vote: selectedSlot, answer: selectedAnswer }, !!question);
  const lockIn = () => {
    if (selectedSlot === null || !picked) return;
    onChange(placeCurrent(state, selectedSlot, selectedAnswer));
    setSelectedSlot(null);
    setSelectedAnswer(null);
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
    setSelectedAnswer(null);
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

  const nextPlayer = upNext(state);
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
                  {state.stealing && <p className="steal-banner">{t.modes.stealBanner}</p>}
                  {gameMode === 'betting' && <BetPicker bet={state.bet ?? 0} onSet={(n) => onChange(setBet(state, n))} />}
                  {gameMode === 'speed' && <SpeedClock deadline={state.deadline ?? null} />}
                  {gameMode === 'intro' && (
                    <IntroInfo
                      clipMs={clip}
                      onReplay={songStatus === 'ready' ? () => void replayIntro() : undefined}
                      onLonger={
                        songStatus === 'ready'
                          ? () => {
                              onChange(longerClip(state));
                              void replayIntro();
                            }
                          : undefined
                      }
                    />
                  )}
                  {modeOf(state) === 'powerups' && (
                    <PowerUps game={gameView(state)!} onUse={(power, target) => onChange(applyPower(state, power, target))} />
                  )}
                  {question && (
                    <BonusQuestion
                      kind={question.kind}
                      choices={question.choices}
                      selected={hostVoting ? (hostMember.answer ?? null) : selectedAnswer}
                      onSelect={(choice) => (hostVoting ? host.act({ type: 'answer', choice }) : setSelectedAnswer(choice))}
                      votes={answerVotes}
                    />
                  )}
                  {songStatus === 'error' && !songMissing && (
                    <p>
                      <button className="link" onClick={() => setAttempt((n) => n + 1)}>
                        {tg.tryAgain}
                      </button>
                    </p>
                  )}
                </div>
              ) : (
                state.lastGuess && <Reveal guess={state.lastGuess} players={state.players} />
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
                      disabled={!readyToLock(hostMember, !!question)}
                      onClick={() => host.act({ type: 'lock', locked: true })}
                    >
                      {readyToLock(hostMember, !!question) ? tg.lockMyVote : question ? t.modes.tapToVoteBoth : tg.tapToVote}
                    </button>
                  )}
                  {host.decision.kind === 'waiting' && (
                    <p className="hint center vote-status">
                      {tg.teamLocked(host.decision.locked, host.decision.total)}
                    </p>
                  )}
                  {host.decision.kind === 'split' && (
                    <p className="warn center vote-status">{question ? t.modes.split : tg.split}</p>
                  )}
                </>
              ) : state.phase === 'guessing' ? (
                <>
                  <button className="primary big" disabled={!picked} onClick={lockIn}>
                    {!picked
                      ? host.decision.kind === 'none'
                        ? question
                          ? t.modes.pickBoth
                          : tg.pickSpot
                        : tg.waitingVotes
                      : tg.lockGuess}
                  </button>
                  {host.decision.kind === 'waiting' && (
                    <p className="hint center vote-status">
                      {tg.phonesLocked(host.decision.locked, host.decision.total)}
                    </p>
                  )}
                  {host.decision.kind === 'split' && (
                    <p className="warn center vote-status">{question ? t.modes.split : tg.split}</p>
                  )}
                </>
              ) : (
                <>
                  <button className="primary big" onClick={next}>
                    {state.winnerIds.length
                      ? tg.seeWinner
                      : state.lastGuess?.stealNext
                        ? t.modes.nextSteal(nextPlayer.name)
                        : tg.next(nextPlayer.name)}
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
                ({scoreOf(player)}/{state.targetCards})
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

      {/* The Spotify embed lives here, invisible above the player bar unless opened: it shows the title. */}
      <section
        className={`embed-wrap ${mode === 'embed' && state.phase !== 'finished' ? 'pop' : 'hidden'} ${showPlayer ? 'open' : ''}`}
        aria-hidden={!showPlayer}
      >
        {state.phase === 'guessing' && <p className="hint embed-note">{tg.spotifyShowsTitle}</p>}
        <div ref={embedHost} className="embed-host" />
      </section>

      {state.phase !== 'finished' && (mode !== 'none' || state.phase === 'guessing') && (
        <PlayerBar
          silent={mode === 'none'}
          note={tg.noAudio}
          playing={playing}
          canPlay={!!playback && songStatus === 'ready' && !starting}
          status={
            playbackError
              ? tg.playerUnavailable
              : !playback
                ? tg.startingPlayer
                : songStatus === 'loading'
                  ? tg.findingSong
                  : starting
                    ? tg.oneMoment
                    : null
          }
          progress={progress}
          onToggle={() => void togglePlay()}
          onSeek={songStatus === 'ready' && !intro ? (ms) => void seek(ms) : undefined}
          onSkip={state.phase === 'guessing' ? skip : undefined}
          extra={
            mode === 'embed' && (
              <button
                className={`ghost player-icon ${showPlayer ? 'selected' : ''}`}
                onClick={() => setShowPlayer((v) => !v)}
                aria-pressed={showPlayer}
                aria-label={showPlayer ? tg.hideSpotify : tg.showSpotify}
                title={showPlayer ? tg.hideSpotify : tg.showSpotify}
              >
                {showPlayer ? '⌄' : '⌃'}
              </button>
            )
          }
        />
      )}

      {refillNote && <p className="hint center">{refillNote}</p>}
      {state.phase === 'revealed' && waitingForSongs(state) && <p className="hint center">{tg.waitingForSongs}</p>}
      <footer className="game-footer">
        <span className="muted">
          {tg.round(state.round)} · {state.refill ? tg.moreOnTheWay : tg.songsLeft(state.deck.length)}
        </span>
        <button className="link" onClick={quit}>
          {tg.endGame}
        </button>
      </footer>
    </main>
  );
}

export function Scoreboard({ state }: { state: Pick<GameState, 'players' | 'currentPlayerIndex' | 'phase' | 'targetCards'> }) {
  const t = useT();
  return (
    <ol className="scoreboard">
      {state.players.map((p, i) => (
        <li key={p.id} className={`${i === state.currentPlayerIndex && state.phase !== 'finished' ? 'active' : ''} ${p.out ? 'out' : ''}`}>
          <span className="name">
            {p.name}
            {p.out && <span className="badge">💀 {t.modes.outTag}</span>}
            {p.frozen && <span className="badge">🧊 {t.modes.frozenTag}</span>}
          </span>
          <span className="count">
            {scoreOf(p)}
            <span className="muted">/{state.targetCards}</span>
            {!!p.stars && (
              <span className="stars" title={t.modes.stars(p.stars)} aria-label={t.modes.stars(p.stars)}>
                {' '}⭐{p.stars}
              </span>
            )}
            {p.coins !== undefined && (
              <span className="stars" title={t.modes.coins(p.coins)} aria-label={t.modes.coins(p.coins)}>
                {' '}🪙{p.coins}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function Reveal({ guess, players }: { guess: LastGuess; players: readonly Player[] }) {
  const t = useT();
  const tm = t.modes;
  const { correct, song, bonus } = guess;
  const nameOf = (id: string) => players.find((p) => p.id === id)?.name ?? '';
  return (
    <div className={`reveal ${correct ? 'right' : 'wrong'}`}>
      <p className="verdict">
        {guess.steal ? (correct ? tm.stolen : tm.stealMissed) : correct ? t.game.correct : t.game.wrong}
      </p>
      {bonus && <BonusOutcome result={bonus} />}
      {guess.coin && <p className="mode-note">{tm.coinEarned}</p>}
      {guess.timeout && <p className="mode-note out">{tm.timeout}</p>}
      {guess.fast && <p className="mode-note">{tm.fast}</p>}
      {!!guess.bet && (
        <p className={`mode-note ${correct ? '' : 'out'}`}>{correct ? tm.starsWon(guess.bet) : tm.starsLost(guess.bet)}</p>
      )}
      {guess.bet === undefined && !guess.fast && !!guess.stars && guess.stars > 0 && <p className="mode-note">{tm.introStars(guess.stars)}</p>}
      {guess.stealNext && <p className="mode-note">{tm.stealNext(nameOf(guess.stealNext))}</p>}
      {guess.eliminated && <p className="mode-note out">{tm.eliminated(nameOf(guess.playerId))}</p>}
      <RevealArt song={song} />
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

/**
 * The picture for the revealed song: the film, show, game or musical for
 * soundtracks, else the album cover. Shows nothing until found, or if none is.
 */
function RevealArt({ song }: { song: GameState['deck'][number] }) {
  const t = useT();
  const [art, setArt] = useState<{ id: string; art: Artwork | null } | null>(null);
  const [broken, setBroken] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadArtwork(song).then((a) => live && setArt({ id: song.id, art: a }));
    return () => {
      live = false;
    };
  }, [song]);
  if (!art || art.id !== song.id || !art.art || broken === art.art.url) return null;
  const { url, kind } = art.art;
  return (
    <img
      className={`reveal-art ${kind}`}
      src={url}
      alt={kind === 'work' && song.from ? t.game.artWork(song.from) : t.game.artAlbum(song.title, song.artist)}
      referrerPolicy="no-referrer"
      onError={() => setBroken(url)}
    />
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
  state: Pick<GameState, 'players' | 'winnerIds' | 'mode'>;
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
            {p.name}{' '}
            <span className="muted">
              {usesStars(modeOf(state)) ? t.modes.points(p.timeline.length, p.stars ?? 0) : t.game.cards(p.timeline.length)}
            </span>
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
