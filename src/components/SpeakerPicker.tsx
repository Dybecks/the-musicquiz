import { useCallback, useEffect, useRef, useState } from 'react';
import { connectBridge, isBridgeCode, normalizeBridgeCode, type BridgeLink, type SonosSpeaker } from '../sonos/bridge';
import { SPOTIFY_APP, type SpeakerChoice } from '../speakers';
import { getDevices, type SpotifyDevice } from '../spotify/api';
import { isLoggedIn } from '../spotify/auth';
import { connectDevices, findTarget, listError, type ConnectTarget } from '../spotify/remote';

const CODE_KEY = 'mq.sonosCode';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function savedCode(): string {
  try {
    return localStorage.getItem(CODE_KEY) ?? '';
  } catch {
    return '';
  }
}

const ICONS: Record<string, string> = {
  Computer: '💻',
  Smartphone: '📱',
  Tablet: '📱',
  Speaker: '🔈',
  AVR: '🔈',
  CastAudio: '🔈',
  AudioDongle: '🔈',
  TV: '📺',
  CastVideo: '📺',
  STB: '📺',
  GameConsole: '🎮',
  Automobile: '🚗',
};
const icon = (type: string) => ICONS[type] ?? '🔊';

/**
 * The account's Spotify Connect devices: asked for when the picker opens (one
 * request), and again on coming back to the page, since a speaker woken in the
 * Spotify app shows up only then.
 */
function useConnectDevices(enabled: boolean) {
  const [devices, setDevices] = useState<SpotifyDevice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const asking = useRef(false);
  const look = useCallback(async () => {
    if (!enabled || asking.current) return;
    asking.current = true;
    setBusy(true);
    try {
      setDevices(connectDevices(await getDevices()));
      setNote(null);
    } catch (e) {
      setNote(listError(e));
    } finally {
      asking.current = false;
      setBusy(false);
    }
  }, [enabled]);
  useEffect(() => {
    void look();
    const back = () => document.visibilityState === 'visible' && void look();
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [look]);
  return { devices, busy, note, look };
}

/**
 * "Play the music on": this device, a Spotify Connect device (a speaker, TV,
 * or the Spotify app on a computer or phone), wherever the Spotify app plays,
 * or a Sonos speaker through the Sonos bridge.
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
  const connect = useConnectDevices(loggedIn);
  const picked = choice?.kind === 'spotify-device' ? choice.device : null;
  // The picked device stays on the list while Spotify can't see it, so it's clear what is chosen.
  const pickedListed = picked && connect.devices ? findTarget(connect.devices, picked) : undefined;
  const connectShown: (SpotifyDevice | ConnectTarget)[] = [...(picked && !pickedListed ? [picked] : []), ...(connect.devices ?? [])];
  const isPicked = (d: SpotifyDevice | ConnectTarget) => !!picked && (pickedListed ? d === pickedListed : d === picked);
  const locked = connect.devices?.filter((d) => d.is_restricted || !d.id) ?? [];

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
        {connectShown.map((d) => {
          const lockedOne = 'is_restricted' in d && (d.is_restricted || !d.id);
          return (
            <button
              key={`${d.id}:${d.name}`}
              role="radio"
              aria-checked={isPicked(d)}
              className={`chip ${isPicked(d) ? 'selected' : ''}`}
              disabled={lockedOne}
              title={lockedOne ? 'Spotify won’t let other apps control this one' : undefined}
              onClick={() => onChange({ kind: 'spotify-device', device: { id: d.id!, name: d.name, type: d.type } })}
            >
              <span aria-hidden>{icon(d.type)}</span> {d.name}
              {lockedOne && <span aria-label="locked"> 🔒</span>}
            </button>
          );
        })}
        {loggedIn && (
          <button
            role="radio"
            aria-checked={choice?.kind === 'spotify-app'}
            className={`chip ${choice?.kind === 'spotify-app' ? 'selected' : ''}`}
            onClick={() => onChange(SPOTIFY_APP)}
          >
            Wherever Spotify plays
          </button>
        )}
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
      {loggedIn ? (
        <>
          <p className="hint">
            {connect.devices === null && !connect.note ? (
              'Looking for Spotify speakers…'
            ) : (
              <>
                <strong>Spotify speakers and apps:</strong> speakers, TVs and the Spotify app on computers (PC or Mac) and phones that your Spotify account can
                play on. The game starts each song there; nothing plays on this device. Needs Spotify Premium. Spotify shows the title in its app (and on a TV),
                so keep it out of sight.
              </>
            )}
          </p>
          {connect.note && <p className="warn">{connect.note}</p>}
          <p className="hint">
            Missing one? Switch it on, open the Spotify app, pick it in the device list (the speaker icon) and start any song, then come back here.{' '}
            <button className="link" onClick={() => void connect.look()} disabled={connect.busy}>
              {connect.busy ? 'Looking…' : '↻ Look again'}
            </button>
          </p>
          {locked.length > 0 && (
            <p className="hint">
              🔒 Spotify won’t let other apps control {locked.map((d) => `“${d.name}”`).join(', ')}. For a Sonos, use the Sonos bridge below.
            </p>
          )}
        </>
      ) : (
        <p className="hint">
          Spotify speakers, TVs and computers need the Spotify login (Premium): end the game and choose “Log in with Spotify” in setup.
        </p>
      )}
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
