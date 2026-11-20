import { useEffect, useState } from 'react';
import type { HostRoom } from '../multiplayer/useHostRoom';
import { HOST_ID, type Member } from '../multiplayer/protocol';
import { useT } from '../i18n';

/** The link a phone opens to join this game. */
export const joinLink = (code: string) => `${new URL(import.meta.env.BASE_URL, window.location.origin)}?join=${code}`;

/**
 * Invites phones, before or during a game: the code, who has joined and
 * which team they are on, and the host's own name and team.
 */
export function SharePanel({ host, lobby }: { host: HostRoom; lobby?: boolean }) {
  const tt = useT();
  const t = tt.share;
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
        <h2>{lobby ? t.inviteTitle : t.playTogether}</h2>
        <p className="hint">{t.intro}</p>
        <button className="ghost" onClick={host.share}>
          {t.shareCode}
        </button>
      </section>
    );
  }

  const link = joinLink(room.code);
  const shareLink = async () => {
    const data = { title: tt.app.name, text: t.shareText(room.code), url: link };
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
          <p className="hint">{t.gameCode}</p>
          <p className="room-code" aria-label={t.gameCodeSpelled(room.code)}>
            {room.code}
          </p>
        </div>
        <button className="ghost" onClick={shareLink}>
          {copied ? t.linkCopied : t.shareLink}
        </button>
      </div>
      <p className="hint">
        {status?.kind === 'open'
          ? t.howToJoin
          : status?.kind === 'error'
            ? status.message
            : t.opening}
      </p>

      <div className="host-me">
        {me?.emoji && (
          <button className="avatar-button" title={t.anotherPicture} onClick={() => host.act({ type: 'reroll' })}>
            {me.emoji}
          </button>
        )}
        <label className="field">
          <span>{t.yourName}</span>
          <input
            value={name}
            maxLength={24}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && host.act({ type: 'hello', memberId: HOST_ID, name })}
          />
        </label>
        <p className="hint">{t.yourTeam}</p>
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
            {t.justRunning}
          </button>
        </div>
      </div>

      <ul className="team-members">
        {teams.map((t) => {
          const members = room.members.filter((m) => m.teamId === t.id);
          return (
            <li key={t.id}>
              <strong>{t.name}</strong>
              <span>{members.length ? members.map((m) => <MemberName key={m.id} member={m} />) : <span className="muted">{tt.share.nobodyYet}</span>}</span>
            </li>
          );
        })}
        {unassigned.length > 0 && (
          <li>
            <strong className="muted">{t.choosingTeam}</strong>
            <span>
              {unassigned.map((m) => (
                <MemberName key={m.id} member={m} />
              ))}
            </span>
          </li>
        )}
      </ul>
      {pending > 0 && <p className="hint">{t.pending(pending)}</p>}
      <button className="link" onClick={() => host.stop('stopped')}>
        {t.stop}
      </button>
    </section>
  );
}

function MemberName({ member }: { member: Member }) {
  const t = useT().share;
  return (
    <span className={`member ${member.connected ? '' : 'offline'}`} title={member.connected ? undefined : t.notConnected}>
      {member.emoji && <span className="avatar">{member.emoji}</span>}
      {member.name}
      {member.id === HOST_ID && t.host}
      {member.locked && ' ✓'}
      {member.songs ? <span className="muted">{t.memberSongs(member.songs)}</span> : null}
    </span>
  );
}
