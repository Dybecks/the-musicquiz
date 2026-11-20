import { useEffect, useState } from 'react';
import type { HostRoom } from '../multiplayer/useHostRoom';
import { HOST_ID, nextRuleOf, type Member } from '../multiplayer/protocol';
import { useT } from '../i18n';
import { Rich } from '../i18n/Rich';

/** The link a phone opens to join this game. */
export const joinLink = (code: string) => `${new URL(import.meta.env.BASE_URL, window.location.origin)}?join=${code}`;

/**
 * Invites phones, before or during a game: the code, who has joined and
 * which team they are on, and the host's own name and team.
 */
export function SharePanel({ host, lobby }: { host: HostRoom; lobby?: boolean }) {
  const texts = useT();
  const s = texts.share;
  const [copied, setCopied] = useState(false);
  const { room, status, teams } = host;
  const me = room?.members.find((m) => m.id === HOST_ID);
  const [name, setName] = useState(me?.name ?? '');
  /** The member the host tapped, to move or remove. */
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    if (me && !name) setName(me.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.name]);

  if (!room) {
    return (
      <section className="panel share">
        <h2>{lobby ? s.inviteTitle : s.playTogether}</h2>
        <p className="hint">{s.intro}</p>
        <button className="ghost" onClick={host.share}>
          {s.shareCode}
        </button>
      </section>
    );
  }

  const link = joinLink(room.code);
  const shareLink = async () => {
    const data = { title: texts.app.name, text: s.shareText(room.code), url: link };
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
  const pickedMember = others.find((m) => m.id === picked) ?? null;
  const pick = (id: string) => setPicked((cur) => (cur === id ? null : id));

  return (
    <section className="panel share">
      <div className="share-head">
        <div>
          <p className="hint">{s.gameCode}</p>
          <p className="room-code" aria-label={s.gameCodeSpelled(room.code)}>
            {room.code}
          </p>
        </div>
        <button className="ghost" onClick={shareLink}>
          {copied ? s.linkCopied : s.shareLink}
        </button>
      </div>
      <p className="hint">
        {status?.kind === 'open'
          ? s.howToJoin
          : status?.kind === 'error'
            ? status.message
            : s.opening}
      </p>

      <div className="host-me">
        {me?.emoji && (
          <button className="avatar-button" title={s.anotherPicture} onClick={() => host.act({ type: 'reroll' })}>
            {me.emoji}
          </button>
        )}
        <label className="field">
          <span>{s.yourName}</span>
          <input
            value={name}
            maxLength={24}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && host.act({ type: 'hello', memberId: HOST_ID, name })}
          />
        </label>
        <p className="hint">{s.yourTeam}</p>
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
            {s.justRunning}
          </button>
        </div>
      </div>

      <ul className="team-members">
        {teams.map((t) => {
          const members = room.members.filter((m) => m.teamId === t.id);
          return (
            <li key={t.id}>
              <strong>{t.name}</strong>
              <button
                className="link small"
                aria-label={s.rename(t.name)}
                onClick={() => {
                  const next = window.prompt(s.newName(t.name), t.name);
                  if (next !== null) host.renameTeam(t.id, next);
                }}
              >
                ✎
              </button>
              <span>
                {members.length ? (
                  members.map((m) => <MemberName key={m.id} member={m} picked={picked === m.id} onPick={pick} />)
                ) : (
                  <span className="muted">{s.nobodyYet}</span>
                )}
              </span>
            </li>
          );
        })}
        {unassigned.length > 0 && (
          <li>
            <strong className="muted">{s.choosingTeam}</strong>
            <span>
              {unassigned.map((m) => (
                <MemberName key={m.id} member={m} picked={picked === m.id} onPick={pick} />
              ))}
            </span>
          </li>
        )}
      </ul>
      {pickedMember && (
        <div className="member-manage" role="group" aria-label={s.manage(pickedMember.name)}>
          <p className="hint">
            <Rich text={s.moveTo(pickedMember.name)} />
          </p>
          <div className="chips">
            {teams.map((t) => (
              <button
                key={t.id}
                className={`chip ${pickedMember.teamId === t.id ? 'selected' : ''}`}
                aria-pressed={pickedMember.teamId === t.id}
                onClick={() => {
                  host.move(pickedMember.id, t.id);
                  setPicked(null);
                }}
              >
                {t.name}
              </button>
            ))}
            <button
              className={`chip ${!pickedMember.teamId ? 'selected' : ''}`}
              aria-pressed={!pickedMember.teamId}
              onClick={() => {
                host.move(pickedMember.id, null);
                setPicked(null);
              }}
            >
              {s.noTeam}
            </button>
          </div>
          <p>
            <button
              className="link danger"
              onClick={() => {
                if (!window.confirm(s.confirmRemove(pickedMember.name))) return;
                host.kick(pickedMember.id);
                setPicked(null);
              }}
            >
              {s.remove}
            </button>{' '}
            ·{' '}
            <button className="link" onClick={() => setPicked(null)}>
              {s.done}
            </button>
          </p>
        </div>
      )}
      {others.length > 0 && !pickedMember && <p className="hint">{s.tapName}</p>}
      {(room.kicked?.length ?? 0) > 0 && (
        <p className="hint">
          {s.removed}{' '}
          {room.kicked!.map((k, i) => (
            <span key={k.id}>
              {i > 0 && ', '}
              {k.name} (
              <button className="link" onClick={() => host.letBackIn(k.id)}>
                {s.letBackIn}
              </button>
              )
            </span>
          ))}
        </p>
      )}
      <div className="next-rule">
        <p className="hint">{s.nextRuleQuestion}</p>
        <div className="chips" role="radiogroup" aria-label={s.nextRuleLabel}>
          {(['majority', 'anyone', 'host'] as const).map((r) => (
            <button key={r} role="radio" aria-checked={nextRuleOf(room) === r} className={`chip ${nextRuleOf(room) === r ? 'selected' : ''}`} onClick={() => host.setNextRule(r)}>
              {s.nextRules[r]}
            </button>
          ))}
        </div>
        <p className="hint">
          {s.nextRuleHints[nextRuleOf(room)]}
        </p>
      </div>
      {pending > 0 && <p className="hint">{s.pending(pending)}</p>}
      <button className="link" onClick={() => host.stop('stopped')}>
        {s.stop}
      </button>
    </section>
  );
}

function MemberName({ member, picked, onPick }: { member: Member; picked: boolean; onPick: (id: string) => void }) {
  const s = useT().share;
  const content = (
    <>
      {member.emoji && <span className="avatar">{member.emoji}</span>}
      {member.name}
      {member.id === HOST_ID && s.host}
      {member.locked && ' ✓'}
      {member.songs ? <span className="muted">{s.memberSongs(member.songs)}</span> : null}
    </>
  );
  const cls = `member ${member.connected ? '' : 'offline'} ${picked ? 'picked' : ''}`;
  const title = member.connected ? undefined : s.notConnected;
  // The host's own device is managed above (name and team), not here.
  if (member.id === HOST_ID)
    return (
      <span className={cls} title={title}>
        {content}
      </span>
    );
  return (
    <button className={`${cls} member-button`} title={title} aria-pressed={picked} onClick={() => onPick(member.id)}>
      {content}
    </button>
  );
}
