import { useState } from 'react';
import { POWERS, POWER_COST, attackTargets, isAttack, type Player, type Power } from '../game/engine';
import type { GameView } from '../multiplayer/protocol';
import { useT } from '../i18n';

const ICON: Record<Power, string> = { hint: '💡', retry: '🔁', freeze: '🧊', grab: '🫳' };

/**
 * The power-ups the team whose turn it is can buy (mode 'powerups'), and what
 * is already in use this turn. Without `onUse` it is only shown.
 */
export function PowerUps({
  game,
  onUse,
}: {
  game: Pick<GameView, 'players' | 'currentPlayerIndex' | 'powers'>;
  onUse?: (power: Power, target?: string) => void;
}) {
  const t = useT();
  const tm = t.modes;
  const [aiming, setAiming] = useState<Power | null>(null);
  const me = game.players[game.currentPlayerIndex];
  const coins = me.coins ?? 0;
  const used = game.powers ?? {};
  const names: Record<Power, [string, string]> = {
    hint: [tm.hint, tm.hintDetail],
    retry: [tm.retry, tm.retryDetail],
    freeze: [tm.freeze, tm.freezeDetail],
    grab: [tm.grab, tm.grabDetail],
  };
  const available = (power: Power): boolean => {
    if (coins < POWER_COST[power]) return false;
    if (power === 'hint') return used.hintDecade === undefined;
    if (power === 'retry') return !used.retry;
    return !used.attacked && attackTargets(game, power).length > 0;
  };
  const targets: Player[] = aiming ? attackTargets(game, aiming) : [];

  return (
    <section className="powerups" aria-label={tm.powersTitle(coins)}>
      <p className="bonus-label">{tm.powersTitle(coins)}</p>
      {used.hintDecade !== undefined && <p className="power-note">{tm.hintShown(used.hintDecade)}</p>}
      {used.retry && <p className="power-note">{used.missedSlot !== undefined ? tm.retryNow : tm.retryActive}</p>}
      {aiming ? (
        <div className="power-targets">
          <p>
            {ICON[aiming]} {names[aiming][0]}: {tm.pickTarget}
          </p>
          <div className="power-grid">
            {targets.map((p) => (
              <button
                key={p.id}
                className="power"
                onClick={() => {
                  onUse?.(aiming, p.id);
                  setAiming(null);
                }}
              >
                <strong>{p.name}</strong>
              </button>
            ))}
            <button className="ghost" onClick={() => setAiming(null)}>
              {t.setup.cancel}
            </button>
          </div>
        </div>
      ) : (
        onUse && (
          <div className="power-grid">
            {POWERS.map((power) => (
              <button
                key={power}
                className="power"
                disabled={!available(power)}
                onClick={() => (isAttack(power) ? setAiming(power) : onUse(power))}
              >
                <strong>
                  {ICON[power]} {names[power][0]}
                </strong>
                <span>{names[power][1]}</span>
                <small className="cost">{tm.cost(POWER_COST[power])}</small>
              </button>
            ))}
          </div>
        )
      )}
    </section>
  );
}
