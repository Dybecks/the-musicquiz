import { useEffect, useRef, useState } from 'react';
import { connectBridge, isBridgeCode, normalizeBridgeCode, type BridgeLink, type SonosSpeaker } from '../sonos/bridge';
import { SPOTIFY_APP, type SpeakerChoice } from '../speakers';
import { isLoggedIn } from '../spotify/auth';
import { msg, useT } from '../i18n';

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
  const t = useT().speakers;
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
      if (found.length === 0) setNote(msg().speakers.noSonos);
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
      <h2>{t.playOn}</h2>
      <div className="chips" role="radiogroup" aria-label={t.playOn}>
        <button role="radio" aria-checked={!choice} className={`chip ${!choice ? 'selected' : ''}`} onClick={() => onChange(null)}>
          {t.thisDevice}
        </button>
        <button
          role="radio"
          aria-checked={choice?.kind === 'spotify-app'}
          className={`chip ${choice?.kind === 'spotify-app' ? 'selected' : ''}`}
          disabled={!loggedIn}
          onClick={() => onChange(SPOTIFY_APP)}
        >
          {t.spotifyApp}
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
            <strong>{t.appHintTitle}</strong> {t.appHint}
          </>
        ) : (
          <>
            <strong>{t.appNeedsLoginTitle}</strong> {t.appNeedsLogin}
          </>
        )}
      </p>
      <details className="sonos-bridge" open={!!sonosChoice || undefined}>
        <summary>{t.sonosBridge}</summary>
        <form
          className="sonos-code"
          onSubmit={(e) => {
            e.preventDefault();
            void find();
          }}
        >
          <label>
            {t.bridgeCode}
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
            {busy ? t.looking : speakers ? t.lookAgain : t.findSonos}
          </button>
        </form>
        {note && <p className="warn">{note}</p>}
        <p className="hint">{t.sonosHint}</p>
      </details>
    </div>
  );
}
