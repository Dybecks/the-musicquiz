import { useEffect, useState } from 'react';
import type { HostRoom } from '../multiplayer/useHostRoom';
import { HOST_ID, type Member } from '../multiplayer/protocol';

/** The link a phone opens to join this game. */
export const joinLink = (code: string) => `${new URL(import.meta.env.BASE_URL, window.location.origin)}?join=${code}`;

/**
 * Invites phones, before or during a game: the code, who has joined and
 * which team they are on, and the host's own name and team.
 */
export function SharePanel({ host, lobby }: { host: HostRoom; lobby?: boolean }) {
  const [copied, setCopied] = useState(false);
  const { room, status, teams } = host;
  const me = room?.members.find((m) => m.id === HOST_ID);
  const [name, setName] = useState(me?.name ?? '');
  useEffect(() => {
    if (me && !name) setName(me.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.name]);

  if (!room) {
    return (
      <section className="panel share">
        <h2>{lobby ? 'Invite players to their phones' : 'Play together on phones'}</h2>
        <p className="hint">
          Share a code so everyone can follow the game on their own phone or computer, join a team and vote for the spot
          before the team locks in together. They can also add songs from their own Spotify if they like. The music
          still plays here.
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
  const others = room.members.filter((m) => m.id !== HOST_ID);
  const unassigned = others.filter((m) => !m.teamId || !teams.some((t) => t.id === m.teamId));
  const pending = room.pending?.length ?? 0;

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
          ? 'On a phone or computer, open the game, choose “Join a game” and type the code, or open the link.'
          : status?.kind === 'error'
            ? status.message
            : 'Opening the room…'}
      </p>

      <div className="host-me">
        {me?.emoji && (
          <button className="avatar-button" title="Tap for another picture" onClick={() => host.act({ type: 'reroll' })}>
            {me.emoji}
          </button>
        )}
        <label className="field">
          <span>Your name on this device</span>
          <input
            value={name}
            maxLength={24}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && host.act({ type: 'hello', memberId: HOST_ID, name })}
          />
        </label>
        <p className="hint">Your team (you vote here, on this screen):</p>
        <div className="chips">
          {teams.map((t) => (
            <button
              key={t.id}
              className={`chip ${me?.teamId === t.id ? 'selected' : ''}`}
              aria-pressed={me?.teamId === t.id}
              onClick={() => host.act({ type: 'team', teamId: t.id })}
            >
              {t.name}
            </button>
          ))}
          <button
            className={`chip ${!me?.teamId ? 'selected' : ''}`}
            aria-pressed={!me?.teamId}
            onClick={() => host.act({ type: 'team', teamId: null })}
          >
            Just running the game
          </button>
        </div>
      </div>

      <ul className="team-members">
        {teams.map((t) => {
          const members = room.members.filter((m) => m.teamId === t.id);
          return (
            <li key={t.id}>
              <strong>{t.name}</strong>
              <span>{members.length ? members.map((m) => <MemberName key={m.id} member={m} />) : <span className="muted">nobody yet</span>}</span>
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
      {pending > 0 && <p className="hint">{pending} songs from players’ Spotify will be added when the game starts.</p>}
      <button className="link" onClick={() => host.stop('The host stopped sharing the game.')}>
        Stop sharing
      </button>
    </section>
  );
}

function MemberName({ member }: { member: Member }) {
  return (
    <span className={`member ${member.connected ? '' : 'offline'}`} title={member.connected ? undefined : 'Not connected'}>
      {member.emoji && <span className="avatar">{member.emoji}</span>}
      {member.name}
      {member.id === HOST_ID && ' (host)'}
      {member.locked && ' ✓'}
      {member.songs ? <span className="muted"> · {member.songs} songs</span> : null}
    </span>
  );
}
