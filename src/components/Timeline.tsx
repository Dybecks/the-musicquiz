import { Fragment } from 'react';
import type { Song } from '../game/engine';
import { msg, useT } from '../i18n';
import { SongArt } from './SongArt';

interface Props {
  cards: Song[];
  selectable: boolean;
  selectedSlot: number | null;
  onSelect: (slot: number) => void;
  /** Card to highlight as newly added. */
  highlightId?: string;
  /** A wrongly placed song, shown where it really belonged. */
  wrongCard?: Song;
  compact?: boolean;
  /** Votes from the team's phones, as slot → names. Shown on the gaps, even when they can't be tapped. */
  votes?: Map<number, string[]>;
}

function slotLabel(cards: Song[], slot: number): string {
  const t = msg().timeline;
  if (cards.length === 0) return t.placeHere;
  if (slot === 0) return t.before(cards[0].year);
  if (slot === cards.length) return t.after(cards[cards.length - 1].year);
  return t.between(cards[slot - 1].year, cards[slot].year);
}

export function Timeline({ cards, selectable, selectedSlot, onSelect, highlightId, wrongCard, compact, votes }: Props) {
  const t = useT();
  // Where the wrong card really belongs (first card with a later year).
  let wrongIndex = -1;
  if (wrongCard) {
    wrongIndex = cards.findIndex((c) => c.year > wrongCard.year);
    if (wrongIndex === -1) wrongIndex = cards.length;
  }

  const slot = (i: number) => {
    const voters = votes?.get(i);
    if (!selectable && !votes) return null;
    return (
      <button
        key={`slot-${i}`}
        className={`slot ${selectedSlot === i ? 'selected' : ''} ${voters ? 'voted' : ''}`}
        aria-pressed={selectable ? selectedSlot === i : undefined}
        disabled={!selectable}
        onClick={() => onSelect(i)}
      >
        <span>
          {selectedSlot === i ? '♪ ' : '+ '}
          {slotLabel(cards, i)}
        </span>
        {voters && (
          <span className="votes" aria-label={t.timeline.votes(voters)}>
            {voters.map((name, j) => (
              <span key={j} className="vote-chip">
                {name}
              </span>
            ))}
          </span>
        )}
      </button>
    );
  };

  return (
    <ol className={`timeline ${compact ? 'compact' : ''}`}>
      {cards.map((card, i) => (
        <Fragment key={card.id}>
          {slot(i)}
          {i === wrongIndex && wrongCard && <WrongCard song={wrongCard} />}
          <li className={`song-card ${card.id === highlightId ? 'new' : ''}`}>
            <span className="year">{card.year}</span>
            <span className="title">{card.title}</span>
            <span className="artist">
              {card.artist}
              {card.from && <span className="from"> · {card.from}</span>}
            </span>
            <SongArt song={card} className="card-art" />
          </li>
        </Fragment>
      ))}
      {slot(cards.length)}
      {wrongIndex === cards.length && wrongCard && <WrongCard song={wrongCard} />}
    </ol>
  );
}

function WrongCard({ song }: { song: Song }) {
  const t = useT();
  return (
    <li className="song-card ghost-card" aria-label={t.timeline.wrongPlace}>
      <span className="year">{song.year}</span>
      <span className="title">{song.title}</span>
      <span className="artist">{t.timeline.belongedHere}</span>
    </li>
  );
}
