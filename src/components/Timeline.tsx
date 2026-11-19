import { Fragment } from 'react';
import type { Song } from '../game/engine';

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
}

function slotLabel(cards: Song[], slot: number): string {
  if (cards.length === 0) return 'Place here';
  if (slot === 0) return `Before ${cards[0].year}`;
  if (slot === cards.length) return `After ${cards[cards.length - 1].year}`;
  return `Between ${cards[slot - 1].year} and ${cards[slot].year}`;
}

export function Timeline({ cards, selectable, selectedSlot, onSelect, highlightId, wrongCard, compact }: Props) {
  // Where the wrong card really belongs (first card with a later year).
  let wrongIndex = -1;
  if (wrongCard) {
    wrongIndex = cards.findIndex((c) => c.year > wrongCard.year);
    if (wrongIndex === -1) wrongIndex = cards.length;
  }

  const slot = (i: number) =>
    selectable ? (
      <button
        key={`slot-${i}`}
        className={`slot ${selectedSlot === i ? 'selected' : ''}`}
        aria-pressed={selectedSlot === i}
        onClick={() => onSelect(i)}
      >
        {selectedSlot === i ? '♪ ' : '+ '}
        {slotLabel(cards, i)}
      </button>
    ) : null;

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
          </li>
        </Fragment>
      ))}
      {slot(cards.length)}
      {wrongIndex === cards.length && wrongCard && <WrongCard song={wrongCard} />}
    </ol>
  );
}

function WrongCard({ song }: { song: Song }) {
  return (
    <li className="song-card ghost-card" aria-label="Where the song really belongs">
      <span className="year">{song.year}</span>
      <span className="title">{song.title}</span>
      <span className="artist">belonged here</span>
    </li>
  );
}
