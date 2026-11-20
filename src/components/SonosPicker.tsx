import { useEffect, useRef, useState } from 'react';
import { connectBridge, isBridgeCode, normalizeBridgeCode, type BridgeLink, type SonosChoice, type SonosSpeaker } from '../sonos/bridge';

const CODE_KEY = 'mq.sonosCode';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function savedCode(): string {
  try {
    return localStorage.getItem(CODE_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * "Play the music on": this device, or a Sonos speaker through the Sonos
 * bridge. The bridge's speaker code is remembered on this device.
 */
export function SonosPicker({ choice, onChange }: { choice: SonosChoice | null; onChange: (c: SonosChoice | null) => void }) {
  const [code, setCode] = useState(() => choice?.code ?? savedCode());
  const [speakers, setSpeakers] = useState<SonosSpeaker[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const link = useRef<BridgeLink | null>(null);

  useEffect(() => () => link.current?.close(), []);

  const find = async () => {
    if (!isBridgeCode(code)) return;
    setBusy(true);
    setNote(null);
    try {
      localStorage.setItem(CODE_KEY, code);
    } catch {
      /* not remembered */
    }
    link.current?.close();
    const l = connectBridge(code);
    link.current = l;
    try {
      const found = await l.list();
      setSpeakers(found);
      if (found.length === 0) setNote('The bridge found no Sonos speakers. Is its computer on the same Wi-Fi as the speakers?');
    } catch (e) {
      setSpeakers(null);
      setNote(message(e));
    } finally {
      setBusy(false);
    }
  };

  const shown: SonosSpeaker[] = [...(choice && !speakers?.some((s) => s.id === choice.speaker.id) ? [choice.speaker] : []), ...(speakers ?? [])];

  return (
    <div className="speakers">
      <h2>Play the music on</h2>
      <div className="chips" role="radiogroup" aria-label="Play the music on">
        <button role="radio" aria-checked={!choice} className={`chip ${!choice ? 'selected' : ''}`} onClick={() => onChange(null)}>
          This device
        </button>
        {shown.map((s) => (
          <button
            key={s.id}
            role="radio"
            aria-checked={choice?.speaker.id === s.id}
            className={`chip ${choice?.speaker.id === s.id ? 'selected' : ''}`}
            onClick={() => onChange({ code, speaker: s })}
          >
            {s.name}
          </button>
        ))}
      </div>
      <form
        className="sonos-code"
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <label>
          Sonos bridge code
          <input
            className="code-input"
            value={code}
            onChange={(e) => setCode(normalizeBridgeCode(e.target.value))}
            placeholder="ABCDEF"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
          />
        </label>
        <button type="submit" className="ghost" disabled={busy || !isBridgeCode(code)}>
          {busy ? 'Looking…' : speakers ? '↻ Look again' : 'Find Sonos speakers'}
        </button>
      </form>
      {note && <p className="warn">{note}</p>}
      <p className="hint">
        Sonos needs the Sonos bridge running on a computer on this Wi-Fi (see “Playing on a Sonos” in the README). It shows the code when it starts. Spotify must be
        added in the Sonos app.
      </p>
    </div>
  );
}
