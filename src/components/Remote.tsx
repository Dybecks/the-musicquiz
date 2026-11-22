import { useEffect, useRef, useState } from 'react';
import { joinRoom, type ClientLink, type ClientStatus } from '../multiplayer/connection';
import {
  cleanTeamName,
  HOST_ID,
  KICKED_REASON,
  MAX_TEAM_NAME,
  nextVotes,
  turnOf,
  isValidCode,
  label,
  normalizeCode,
  votesBySlot,
  votesByAnswer,
  readyToLock,
  type ClientMessage,
  type Member,
  type RoomView,
} from '../multiplayer/protocol';
import type { SpotifyProfile } from '../spotify/api';
import { AddMyMusic } from './AddMyMusic';
import { Finished, Reveal, Scoreboard } from './Game';
import { Timeline } from './Timeline';
import { BonusQuestion } from './BonusQuestion';
import { scoreOf } from '../game/engine';
import { msg, useT } from '../i18n';
import { Rich } from '../i18n/Rich';

/** The game this phone joined last, so a reload carries on. */
const REMOTE_KEY = 'mq.remote';
const MEMBER_KEY = 'mq.memberId';
const NAME_KEY = 'mq.remoteName';

interface Session {
  code: string;
  name: string;
}

export function savedRemote(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(REMOTE_KEY) ?? 'null') as Session | null;
    return s && isValidCode(s.code) ? s : null;
  } catch {
    return null;
  }
}

function memberId(): string {
  let id = localStorage.getItem(MEMBER_KEY);
  if (!id) {
    id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(MEMBER_KEY, id);
  }
  return id;
}

interface Props {
  /** A code from a join link. */
  initialCode?: string;
  onLeave: () => void;
  /** This phone's own Spotify login, if any (only for adding songs). */
  profile: SpotifyProfile | null;
}

/** A phone following a game hosted on another device: pick a team and vote. */
export function Remote({ initialCode, onLeave, profile }: Props) {
  const [session, setSession] = useState<Session | null>(() => {
    const saved = savedRemote();
    return saved && (!initialCode || saved.code === initialCode) ? saved : null;
  });
  const [notice, setNotice] = useState<string | null>(null);

  const leave = () => {
    localStorage.removeItem(REMOTE_KEY);
    onLeave();
  };

  if (!session) {
    return (
      <JoinForm
        initialCode={initialCode}
        notice={notice}
        onJoin={(s) => {
          localStorage.setItem(REMOTE_KEY, JSON.stringify(s));
          localStorage.setItem(NAME_KEY, s.name);
          setNotice(null);
          setSession(s);
        }}
        onBack={leave}
      />
    );
  }
  return (
    <Joined
      key={session.code}
      session={session}
      profile={profile}
      onLeave={leave}
      onNotFound={() => {
        localStorage.removeItem(REMOTE_KEY);
        setNotice(msg().remote.notFound(session.code));
        setSession(null);
      }}
    />
  );
}

function JoinForm({
  initialCode,
  notice,
  onJoin,
  onBack,
}: {
  initialCode?: string;
  notice: string | null;
  onJoin: (s: Session) => void;
  onBack: () => void;
}) {
  const t = useT().remote;
  const [code, setCode] = useState(initialCode ?? '');
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? '');
  const ok = isValidCode(code) && name.trim().length > 0;
  return (
    <main className="setup flow remote">
      <p>
        <button className="link" onClick={onBack}>
          {t.hostInstead}
        </button>
      </p>
      <h2 className="screen-title">{t.joinGame}</h2>
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onJoin({ code, name: name.trim() });
        }}
      >
        <label className="field">
          <span>{t.codeLabel}</span>
          <input
            className="code-input"
            value={code}
            onChange={(e) => setCode(normalizeCode(e.target.value))}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            placeholder="ABCD"
            aria-label={t.codeAria}
          />
        </label>
        <label className="field">
          <span>{t.yourName}</span>
          <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} autoComplete="nickname" placeholder={t.namePlaceholder} />
        </label>
        {notice && <p className="warn">{notice}</p>}
        <button className="primary big" type="submit" disabled={!ok}>
          {t.join}
        </button>
      </form>
      <p className="hint center">{t.joinHint}</p>
    </main>
  );
}

function statusText(status: ClientStatus): string | null {
  switch (status.kind) {
    case 'connecting':
      return msg().remote.connecting;
    case 'reconnecting':
      return msg().remote.reconnecting;
    case 'error':
      return status.message;
    default:
      return null;
  }
}

function Joined({
  session,
  profile,
  onLeave,
  onNotFound,
}: {
  session: Session;
  profile: SpotifyProfile | null;
  onLeave: () => void;
  onNotFound: () => void;
}) {
  const tt = useT();
  const t = tt.remote;
  const [status, setStatus] = useState<ClientStatus>({ kind: 'connecting' });
  const [view, setView] = useState<RoomView | null>(null);
  const [added, setAdded] = useState<number | null>(null);
  const link = useRef<ClientLink | null>(null);
  const me = useRef(memberId()).current;

  useEffect(() => {
    const l = joinRoom(session.code, me, session.name, {
      onStatus: (s) => {
        setStatus(s);
        if (s.kind === 'not-found') onNotFound();
        if (s.kind === 'closed') localStorage.removeItem(REMOTE_KEY);
      },
      onView: setView,
      onSongsAdded: setAdded,
    });
    link.current = l;
    return () => l.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.code, session.name, me]);

  const send = (msg: ClientMessage) => link.current?.send(msg);
  const leave = () => {
    send({ type: 'team', teamId: null });
    onLeave();
  };

  const mine = view?.members.find((m) => m.id === me);

  const header = (
    <div className="remote-head">
      <span className="who">
        {mine?.emoji && (
          <button className="avatar-button small" title={tt.share.anotherPicture} onClick={() => send({ type: 'reroll' })}>
            {mine.emoji}
          </button>
        )}
        <span>
          {session.name} · {t.gameLabel} <strong>{session.code}</strong>
        </span>
      </span>
      <button className="link" onClick={leave}>
        {t.leave}
      </button>
    </div>
  );

  if (status.kind === 'closed') {
    return (
      <main className="remote">
        <section className="panel center">
          <h1>{status.reason === KICKED_REASON ? t.removed : t.gameOver}</h1>
          <p>{closedReason(status.reason)}</p>
          {view?.game && view.game.phase === 'finished' && <Finished state={view.game} />}
          <button className="primary big" onClick={onLeave}>
            {t.back}
          </button>
        </section>
      </main>
    );
  }

  const note = statusText(status);
  const noteLine = note && <p className="warn center">{note}</p>;

  if (!view || !mine) {
    return (
      <main className="remote">
        {header}
        <p className="hint center">{note ?? t.joining}</p>
      </main>
    );
  }

  const game = view.game;
  const myTeam = view.teams.find((t) => t.id === mine.teamId);
  const addMusic = <AddMyMusic profile={profile} added={added} onSend={(songs) => send({ type: 'songs', songs })} />;

  const teamPicker = (
    <>
      <h2 className="screen-title">{myTeam ? t.switchTeam : t.whichTeam}</h2>
      <div className="choices">
        {view.teams.map((t) => {
          const members = view.members.filter((m) => m.teamId === t.id);
          return (
            <button
              key={t.id}
              className={`choice team-choice ${t.id === mine.teamId ? 'selected' : ''}`}
              onClick={() => send({ type: 'team', teamId: t.id })}
            >
              <strong>{t.name}</strong>
              <span>{members.length ? members.map((m) => <Who key={m.id} member={m} />) : tt.remote.nobodyYet}</span>
            </button>
          );
        })}
      </div>
    </>
  );

  // Before the game starts (or between games): pick a team and wait.
  if (!game) {
    return (
      <main className="remote">
        {header}
        {noteLine}
        <section className="panel lobby">
          <h1>{t.waitingStart}</h1>
          <p className="hint">
            {myTeam ? (
              <>
                <Rich text={t.onTeam(myTeam.name)} /> {t.canSwitch}
              </>
            ) : (
              t.pickTeam
            )}
          </p>
          {myTeam && <TeamName team={myTeam} onRename={(name) => send({ type: 'team-name', name })} />}
          {view.pendingSongs > 0 && <p className="hint">{t.pendingSongs(view.pendingSongs)}</p>}
        </section>
        {teamPicker}
        {addMusic}
      </main>
    );
  }

  if (!myTeam) {
    return (
      <main className="remote">
        {header}
        {noteLine}
        {teamPicker}
        {addMusic}
      </main>
    );
  }

  if (game.phase === 'finished') {
    return (
      <main className="remote game">
        {header}
        <Finished state={game} />
        <p className="hint center">{t.stayHere}</p>
      </main>
    );
  }

  const active = game.players[game.currentPlayerIndex];
  const teamMembers = view.members.filter((m) => m.teamId === active.id && m.connected);
  const myTurn = myTeam.id === active.id && game.phase === 'guessing';
  const host = view.members.find((m) => m.id === HOST_ID);
  const question = game.phase === 'guessing' ? game.question ?? null : null;

  // The votes, plus the spot the host has tapped (when the host isn't voting on this team).
  const votes = game.phase === 'guessing' ? votesBySlot(teamMembers) : undefined;
  if (votes && view.live.hostPick !== null && host?.teamId !== active.id) {
    const tag = t.hostTag(host ? label(host) : tt.app.defaultHost);
    votes.set(view.live.hostPick, [...(votes.get(view.live.hostPick) ?? []), tag]);
  }

  return (
    <main className="remote game">
      {header}
      {noteLine}
      <Scoreboard state={game} />
      <div className="board">
        <div className="board-main">
          <section className="panel turn">
            <h1>
              {active.name}
              <span className="muted">{tt.game.turnSuffix(active.name)}</span>
            </h1>
            {game.phase === 'revealed' && game.lastGuess ? (
              <>
                <Reveal correct={game.lastGuess.correct} song={game.lastGuess.song} bonus={game.lastGuess.bonus} />
                <NextSong view={view} me={me} send={send} />
              </>
            ) : (
              <>
                <div className="now-playing">
                  <div className={`vinyl mini ${view.live.playing ? 'spinning' : ''}`} aria-hidden>
                    ?
                  </div>
                  <span className="hint">{view.live.playing ? t.playing : t.waitingSong}</span>
                  {view.nextRule !== 'host' && (
                    <button className="ghost" onClick={() => send({ type: 'play', playing: !view.live.playing })}>
                      {view.live.playing ? tt.game.pause : t.playShort}
                    </button>
                  )}
                </div>
                {myTurn ? (
                  <p>{t.voteHint}</p>
                ) : (
                  <p className="hint">{t.otherVoting(active.name)}</p>
                )}
                {question && (
                  <BonusQuestion
                    kind={question.kind}
                    choices={question.choices}
                    selected={myTurn ? (mine.answer ?? null) : null}
                    onSelect={myTurn ? (choice) => send({ type: 'answer', choice }) : undefined}
                    votes={votesByAnswer(teamMembers)}
                  />
                )}
                <ul className="voters">
                  {teamMembers.map((m) => (
                    <li key={m.id} className={m.locked ? 'locked' : m.vote !== null ? 'voted' : ''}>
                      <Who member={m} />
                      {m.id === me && t.you}: {m.locked ? t.lockedIn : m.vote !== null ? t.voted : t.thinking}
                    </li>
                  ))}
                </ul>
                {view.split && <p className="warn">{question ? tt.modes.split : tt.game.split}</p>}
              </>
            )}
          </section>

          {myTurn && (
            <div className="action-bar">
              {mine.locked ? (
                <button className="ghost big" onClick={() => send({ type: 'lock', locked: false })}>
                  {tt.game.lockedTapToChange}
                </button>
              ) : (
                <button className="primary big" disabled={!readyToLock(mine, !!question)} onClick={() => send({ type: 'lock', locked: true })}>
                  {readyToLock(mine, !!question) ? tt.game.lockMyVote : question ? tt.modes.tapToVoteBoth : tt.game.tapToVote}
                </button>
              )}
            </div>
          )}
        </div>

        <section className="panel board-timeline">
          <h2>
            {tt.game.timeline(active.name)}{' '}
            <span className="muted">
              ({scoreOf(active)}/{game.targetCards})
            </span>
          </h2>
          <Timeline
            cards={active.timeline}
            selectable={myTurn}
            selectedSlot={myTurn ? mine.vote : null}
            onSelect={(slot) => send({ type: 'vote', slot: slot === mine.vote ? null : slot })}
            votes={votes}
            highlightId={game.phase === 'revealed' && game.lastGuess?.correct ? game.lastGuess.song.id : undefined}
            wrongCard={game.phase === 'revealed' && game.lastGuess && !game.lastGuess.correct ? game.lastGuess.song : undefined}
          />
        </section>
      </div>
      <p className="hint center">
        <Rich text={t.onTeam(myTeam.name)} />{' '}
        <button className="link" onClick={() => send({ type: 'team', teamId: null })}>
          {t.changeTeam}
        </button>
      </p>
      <TeamName team={myTeam} onRename={(name) => send({ type: 'team-name', name })} />
      {addMusic}
    </main>
  );
}

/**
 * Why the game ended, in this phone's language. Hosts send a code (see
 * connection.ts); older hosts sent the English text, which is matched too.
 */
function closedReason(reason: string): string {
  const t = msg().remote;
  if (reason === 'ended' || reason === 'The host ended the game.') return t.hostEnded;
  if (reason === 'stopped' || reason === 'The host stopped sharing the game.') return t.hostStopped;
  if (reason === KICKED_REASON) return t.removedText;
  return reason;
}

function Who({ member }: { member: Member }) {
  const t = useT();
  return (
    <span className={`who-chip ${member.connected ? '' : 'offline'}`}>
      {member.emoji && <span className="avatar">{member.emoji}</span>}
      {member.name}
      {member.id === HOST_ID && t.share.host}
    </span>
  );
}

/** Lets a team member rename their team; the host's screen and every phone follow. */
function TeamName({ team, onRename }: { team: { id: string; name: string }; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const t = useT().remote;
  const [name, setName] = useState(team.name);
  if (!editing)
    return (
      <p className="hint center">
        <button
          className="link"
          onClick={() => {
            setName(team.name);
            setEditing(true);
          }}
        >
          {t.renameTeam(team.name)}
        </button>
      </p>
    );
  const clean = cleanTeamName(name);
  return (
    <form
      className="team-rename"
      onSubmit={(e) => {
        e.preventDefault();
        if (clean && clean !== team.name) onRename(clean);
        setEditing(false);
      }}
    >
      <input value={name} maxLength={MAX_TEAM_NAME} onChange={(e) => setName(e.target.value)} aria-label={t.teamName} autoFocus />
      <button type="submit" className="primary" disabled={!clean}>
        {t.save}
      </button>
      <button type="button" className="ghost" onClick={() => setEditing(false)}>
        {t.cancel}
      </button>
    </form>
  );
}

/** After the reveal: move on to the next song, as the host allows (one tap, or most players). */
function NextSong({ view, me, send }: { view: RoomView; me: string; send: (msg: ClientMessage) => void }) {
  const tt = useT();
  const t = tt.remote;
  const game = view.game!;
  const turn = turnOf(game);
  const nextTeam = game.players[(game.currentPlayerIndex + 1) % game.players.length];
  const label = game.winnerIds.length ? tt.game.seeWinner : t.nextSong(nextTeam.name);
  if (view.nextRule === 'host') return <p className="hint center">{t.hostStartsNext}</p>;
  if (view.nextRule === 'anyone')
    return (
      <div className="action-bar">
        <button className="primary big" onClick={() => send({ type: 'next', turn })}>
          {label}
        </button>
      </div>
    );
  const want = view.members.find((m) => m.id === me)?.next === turn;
  const { yes, needed } = nextVotes(view.members, turn);
  return (
    <div className="action-bar">
      {want ? (
        <button className="ghost big" onClick={() => send({ type: 'next', turn, want: false })}>
          {t.readyTapToWait}
        </button>
      ) : (
        <button className="primary big" onClick={() => send({ type: 'next', turn, want: true })}>
          {label}
        </button>
      )}
      <p className="hint center vote-status">
        {t.wantNext(yes, needed)}
      </p>
    </div>
  );
}
