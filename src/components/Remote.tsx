import { useEffect, useRef, useState } from 'react';
import { joinRoom, type ClientLink, type ClientStatus } from '../multiplayer/connection';
import {
  HOST_ID,
  isValidCode,
  label,
  normalizeCode,
  votesBySlot,
  type ClientMessage,
  type Member,
  type RoomView,
} from '../multiplayer/protocol';
import type { SpotifyProfile } from '../spotify/api';
import { AddMyMusic } from './AddMyMusic';
import { Finished, Reveal, Scoreboard } from './Game';
import { Timeline } from './Timeline';

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
        setNotice(`There is no game with code ${session.code} right now. Check the code, and that the host has shared the game.`);
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
  const [code, setCode] = useState(initialCode ?? '');
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? '');
  const ok = isValidCode(code) && name.trim().length > 0;
  return (
    <main className="setup flow remote">
      <p>
        <button className="link" onClick={onBack}>
          ← Host a game instead
        </button>
      </p>
      <h2 className="screen-title">Join a game</h2>
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onJoin({ code, name: name.trim() });
        }}
      >
        <label className="field">
          <span>Game code (on the host’s screen)</span>
          <input
            className="code-input"
            value={code}
            onChange={(e) => setCode(normalizeCode(e.target.value))}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            placeholder="ABCD"
            aria-label="Game code"
          />
        </label>
        <label className="field">
          <span>Your name</span>
          <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} autoComplete="nickname" placeholder="Alex" />
        </label>
        {notice && <p className="warn">{notice}</p>}
        <button className="primary big" type="submit" disabled={!ok}>
          Join
        </button>
      </form>
      <p className="hint center">The music plays on the host’s device. Your phone shows the game and lets you vote.</p>
    </main>
  );
}

function statusText(status: ClientStatus): string | null {
  switch (status.kind) {
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return 'Lost the connection to the host. Reconnecting…';
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
          <button className="avatar-button small" title="Tap for another picture" onClick={() => send({ type: 'reroll' })}>
            {mine.emoji}
          </button>
        )}
        <span>
          {session.name} · Game <strong>{session.code}</strong>
        </span>
      </span>
      <button className="link" onClick={leave}>
        Leave
      </button>
    </div>
  );

  if (status.kind === 'closed') {
    return (
      <main className="remote">
        <section className="panel center">
          <h1>Game over</h1>
          <p>{status.reason}</p>
          {view?.game && view.game.phase === 'finished' && <Finished state={view.game} />}
          <button className="primary big" onClick={onLeave}>
            Back
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
        <p className="hint center">{note ?? 'Joining…'}</p>
      </main>
    );
  }

  const game = view.game;
  const myTeam = view.teams.find((t) => t.id === mine.teamId);
  const addMusic = <AddMyMusic profile={profile} added={added} onSend={(songs) => send({ type: 'songs', songs })} />;

  const teamPicker = (
    <>
      <h2 className="screen-title">{myTeam ? 'Switch team' : 'Which team are you on?'}</h2>
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
              <span>{members.length ? members.map((m) => <Who key={m.id} member={m} />) : 'Nobody yet'}</span>
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
          <h1>Waiting for the host to start</h1>
          <p className="hint">
            {myTeam ? (
              <>
                You’re on <strong>{myTeam.name}</strong>. You can still switch.
              </>
            ) : (
              'Pick your team below.'
            )}
          </p>
          {view.pendingSongs > 0 && <p className="hint">{view.pendingSongs} songs from players will be added at the start.</p>}
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
        <p className="hint center">Stay here: the host can start another game with the same code.</p>
      </main>
    );
  }

  const active = game.players[game.currentPlayerIndex];
  const teamMembers = view.members.filter((m) => m.teamId === active.id && m.connected);
  const myTurn = myTeam.id === active.id && game.phase === 'guessing';
  const host = view.members.find((m) => m.id === HOST_ID);

  // The votes, plus the spot the host has tapped (when the host isn't voting on this team).
  const votes = game.phase === 'guessing' ? votesBySlot(teamMembers) : undefined;
  if (votes && view.live.hostPick !== null && host?.teamId !== active.id) {
    const tag = `${host ? label(host) : 'Host'} (host)`;
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
              <span className="muted">’s turn</span>
            </h1>
            {game.phase === 'revealed' && game.lastGuess ? (
              <Reveal correct={game.lastGuess.correct} song={game.lastGuess.song} />
            ) : (
              <>
                <div className="now-playing">
                  <div className={`vinyl mini ${view.live.playing ? 'spinning' : ''}`} aria-hidden>
                    ?
                  </div>
                  <span className="hint">{view.live.playing ? 'The song is playing…' : 'Waiting for the song to play'}</span>
                </div>
                {myTurn ? (
                  <p>Vote for where the song belongs. The guess goes in when everyone on the team has locked in.</p>
                ) : (
                  <p className="hint">{active.name} is voting. Listen along and see where they put it.</p>
                )}
                <ul className="voters">
                  {teamMembers.map((m) => (
                    <li key={m.id} className={m.locked ? 'locked' : m.vote !== null ? 'voted' : ''}>
                      <Who member={m} />
                      {m.id === me && ' (you)'}: {m.locked ? 'locked in ✓' : m.vote !== null ? 'voted' : 'thinking…'}
                    </li>
                  ))}
                </ul>
                {view.split && <p className="warn">The votes are split. Agree on one spot and lock in again.</p>}
              </>
            )}
          </section>

          {myTurn && (
            <div className="action-bar">
              {mine.locked ? (
                <button className="ghost big" onClick={() => send({ type: 'lock', locked: false })}>
                  Locked in · tap to change
                </button>
              ) : (
                <button className="primary big" disabled={mine.vote === null} onClick={() => send({ type: 'lock', locked: true })}>
                  {mine.vote === null ? 'Tap a spot to vote' : 'Lock in my vote'}
                </button>
              )}
            </div>
          )}
        </div>

        <section className="panel board-timeline">
          <h2>
            {active.name}’s timeline{' '}
            <span className="muted">
              ({active.timeline.length}/{game.targetCards})
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
        You’re on <strong>{myTeam.name}</strong>.{' '}
        <button className="link" onClick={() => send({ type: 'team', teamId: null })}>
          Change team
        </button>
      </p>
      {addMusic}
    </main>
  );
}

function Who({ member }: { member: Member }) {
  return (
    <span className={`who-chip ${member.connected ? '' : 'offline'}`}>
      {member.emoji && <span className="avatar">{member.emoji}</span>}
      {member.name}
      {member.id === HOST_ID && ' (host)'}
    </span>
  );
}
