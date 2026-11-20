import { useEffect, useRef, useState } from 'react';
import { joinRoom, type ClientLink, type ClientStatus } from '../multiplayer/connection';
import { isValidCode, normalizeCode, votesBySlot, type ClientMessage, type RoomView } from '../multiplayer/protocol';
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
}

/** A phone following a game hosted on another device: pick a team and vote. */
export function Remote({ initialCode, onLeave }: Props) {
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

function Joined({ session, onLeave, onNotFound }: { session: Session; onLeave: () => void; onNotFound: () => void }) {
  const [status, setStatus] = useState<ClientStatus>({ kind: 'connecting' });
  const [view, setView] = useState<RoomView | null>(null);
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

  const header = (
    <div className="remote-head">
      <span>
        Game <strong>{session.code}</strong> · {session.name}
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
  const game = view?.game;
  const mine = view?.members.find((m) => m.id === me);

  if (!view || !game || !mine) {
    return (
      <main className="remote">
        {header}
        <p className="hint center">{note ?? 'Joining…'}</p>
      </main>
    );
  }

  const myTeam = game.players.find((p) => p.id === mine.teamId);
  const active = game.players[game.currentPlayerIndex];
  const teamMembers = view.members.filter((m) => m.teamId === active.id && m.connected);
  const myTurn = !!myTeam && myTeam.id === active.id && game.phase === 'guessing';

  if (!myTeam) {
    return (
      <main className="remote">
        {header}
        {note && <p className="warn center">{note}</p>}
        <h2 className="screen-title">Which team are you on?</h2>
        <div className="choices">
          {game.players.map((p) => {
            const members = view.members.filter((m) => m.teamId === p.id);
            return (
              <button key={p.id} className="choice team-choice" onClick={() => send({ type: 'team', teamId: p.id })}>
                <strong>{p.name}</strong>
                <span>{members.length ? members.map((m) => m.name).join(', ') : 'Nobody yet'}</span>
              </button>
            );
          })}
        </div>
      </main>
    );
  }

  if (game.phase === 'finished') {
    return (
      <main className="remote game">
        {header}
        <Finished state={game} />
      </main>
    );
  }

  return (
    <main className="remote game">
      {header}
      {note && <p className="warn center">{note}</p>}
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
            ) : myTurn ? (
              <>
                <p>Listen, then vote for where the song belongs. The guess goes in when everyone on the team has locked in.</p>
                <ul className="voters">
                  {teamMembers.map((m) => (
                    <li key={m.id} className={m.locked ? 'locked' : m.vote !== null ? 'voted' : ''}>
                      {m.name}
                      {m.id === me && ' (you)'}: {m.locked ? 'locked in ✓' : m.vote !== null ? 'voted' : 'thinking…'}
                    </li>
                  ))}
                </ul>
                {view.split && <p className="warn">The votes are split. Agree on one spot and lock in again.</p>}
              </>
            ) : (
              <p className="hint">
                {active.name} is voting. Listen along and see where they put it.
              </p>
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
            votes={game.phase === 'guessing' ? votesBySlot(teamMembers) : undefined}
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
    </main>
  );
}
