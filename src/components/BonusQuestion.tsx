import type { BonusResult, QuestionKind } from '../game/engine';
import { useT } from '../i18n';
import { Rich } from '../i18n/Rich';

/** The question text for each kind of bonus question. */
function useAsk(): (kind: QuestionKind) => string {
  const tm = useT().modes;
  return (kind) =>
    kind === 'artist' ? tm.questionArtist : kind === 'title' ? tm.questionTitle : kind === 'decade' ? tm.questionDecade : tm.questionFrom;
}

/** How a choice is shown: decades are stored as their first year ("1980"). */
function useChoiceLabel(): (kind: QuestionKind, choice: string) => string {
  const tm = useT().modes;
  return (kind, choice) => (kind === 'decade' ? tm.decadeLabel(Number(choice)) : choice);
}

/**
 * The bonus question while the song plays (game mode 'bonus'): four answers
 * to tap, with the team's votes on them. Without `onSelect` it is only shown.
 */
export function BonusQuestion(props: {
  kind: QuestionKind;
  choices: string[];
  selected: number | null;
  onSelect?: (choice: number | null) => void;
  votes?: Map<number, string[]>;
}) {
  const tm = useT().modes;
  const ask = useAsk();
  const labelOf = useChoiceLabel();
  return (
    <section className="bonus-question" aria-label={tm.questionLabel}>
      <p className="bonus-label">⭐ {tm.questionLabel}</p>
      <h3>{ask(props.kind)}</h3>
      <div className="bonus-choices" role="radiogroup" aria-label={ask(props.kind)}>
        {props.choices.map((choice, i) => {
          const voters = props.votes?.get(i);
          return (
            <button
              key={i}
              role="radio"
              aria-checked={props.selected === i}
              className={`bonus-choice ${props.selected === i ? 'selected' : ''} ${voters?.length ? 'voted' : ''}`}
              disabled={!props.onSelect}
              onClick={() => props.onSelect?.(props.selected === i ? null : i)}
            >
              <span>{labelOf(props.kind, choice)}</span>
              {voters && (
                <span className="votes" aria-label={tm.choiceVotes(voters)}>
                  {voters.map((name, j) => (
                    <span key={j} className="vote-chip">
                      {name}
                    </span>
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** How the bonus question went, under the revealed song. */
export function BonusOutcome({ result }: { result: BonusResult }) {
  const tm = useT().modes;
  const labelOf = useChoiceLabel();
  const right = labelOf(result.question.kind, result.question.choices[result.question.answer]);
  return (
    <p className={`bonus-outcome ${result.correct ? 'right' : 'wrong'}`}>
      {result.correct ? tm.bonusRight : <Rich text={result.pick === null ? tm.bonusNone(right) : tm.bonusWrong(right)} />}
    </p>
  );
}
