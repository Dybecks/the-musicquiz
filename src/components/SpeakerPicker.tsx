import { useEffect, useRef, useState } from 'react';
import { connectBridge, isBridgeCode, normalizeBridgeCode, type BridgeLink, type SonosSpeaker } from '../sonos/bridge';
import { SPOTIFY_APP, type SpeakerChoice } from '../speakers';
import { isLoggedIn } from '../spotify/auth';

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
 * "Play the music on": this device, the Spotify app (the game steers it, and
 * it plays wherever it plays), or a Sonos speaker through the Sonos bridge.
 */
export function SpeakerPicker({ choice, onChange }: { choice: SpeakerChoice | null; onChange: (c: SpeakerChoice | null) => void }) {
  const sonosChoice = choice?.kind === 'sonos' ? choice : null;
  const [code, setCode] = useState(() => sonosChoice?.code ?? savedCode());
  const [speakers, setSpeakers] = useState<SonosSpeaker[] | null>(null);
  /** The code the listed speakers were found with. */
  const [foundWith, setFoundWith] = useState(() => sonosChoice?.code ?? '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const link = useRef<BridgeLink | null>(null);
  const loggedIn = isLoggedIn();

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
      setFoundWith(code);
      if (found.length === 0) setNote('The bridge found no Sonos speakers. Is its computer on the same Wi-Fi as the speakers?');
    } catch (e) {
      setSpeakers(null);
      setNote(message(e));
    } finally {
      setBusy(false);
    }
  };

  const shown: SonosSpeaker[] = [...(sonosChoice && !speakers?.some((s) => s.id === sonosChoice.speaker.id) ? [sonosChoice.speaker] : []), ...(speakers ?? [])];
  const isSonos = (s: SonosSpeaker) => sonosChoice?.speaker.id === s.id;

  return (
    <div className="speakers">
      <h2>Play the music on</h2>
      <div className="chips" role="radiogroup" aria-label="Play the music on">
        <button role="radio" aria-checked={!choice} className={`chip ${!choice ? 'selected' : ''}`} onClick={() => onChange(null)}>
          This device
        </button>
        <button
          role="radio"
          aria-checked={choice?.kind === 'spotify-app'}
          className={`chip ${choice?.kind === 'spotify-app' ? 'selected' : ''}`}
          disabled={!loggedIn}
          onClick={() => onChange(SPOTIFY_APP)}
        >
          Spotify app
        </button>
        {shown.map((s) => (
          <button
            key={s.id}
            role="radio"
            aria-checked={isSonos(s)}
            className={`chip ${isSonos(s) ? 'selected' : ''}`}
            onClick={() => onChange({ kind: 'sonos', code: speakers?.some((x) => x.id === s.id) ? foundWith : sonosChoice!.code, speaker: s })}
          >
            {s.name}
          </button>
        ))}
      </div>
      <p className="hint">
        {loggedIn ? (
          <>
            <strong>Spotify app:</strong> the game steers the Spotify app, and the music plays wherever the app plays: the phone, or a speaker you pick in the app
            (the speaker icon), like a Sonos or a TV. Start any song there first. Needs Spotify Premium. The app shows the title, so keep it out of sight.
          </>
        ) : (
          <>
            <strong>Spotify app</strong> needs the Spotify login (Premium): end the game and choose “Log in with Spotify” in setup.
          </>
        )}
      </p>
      <details className="sonos-bridge" open={!!sonosChoice || undefined}>
        <summary>Sonos through the Sonos bridge</summary>
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
          For a Sonos the Spotify app can’t steer. Needs the Sonos bridge running on a computer on this Wi-Fi (see “Playing on a Sonos” in the README); it shows the
          code when it starts.
        </p>
      </details>
    </div>
  );
}
