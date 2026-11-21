import { useSyncExternalStore } from 'react';
import { useT } from '../i18n';

/**
 * Whether the game code is hidden on this screen (say, when it is shown to a
 * room or streamed). Tapping any code on screen hides or shows them all.
 */
const KEY = 'mq.codeHidden';
const subscribers = new Set<() => void>();
let hidden = (() => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
})();

function setHidden(next: boolean) {
  hidden = next;
  try {
    if (next) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* only for this visit */
  }
  subscribers.forEach((cb) => cb());
}

export function useCodeHidden(): [boolean, () => void] {
  const value = useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => hidden,
  );
  return [value, () => setHidden(!hidden)];
}

/** The game code, tap to hide or show it. `small`: the pill at the top of the screen. */
export function RoomCode({ code, small }: { code: string; small?: boolean }) {
  const s = useT().share;
  const [isHidden, toggle] = useCodeHidden();
  return (
    <button
      className={`room-code ${small ? 'small' : ''} ${isHidden ? 'concealed' : ''}`}
      onClick={toggle}
      aria-pressed={isHidden}
      aria-label={isHidden ? `${s.codeHidden}. ${s.showCode}` : `${s.gameCodeSpelled(code)}. ${s.hideCode}`}
      title={isHidden ? s.showCode : s.hideCode}
    >
      {small && <span className="room-code-label">{s.gameCode}</span>}
      <span className="room-code-value">{isHidden ? '•'.repeat(code.length) : code}</span>
    </button>
  );
}
