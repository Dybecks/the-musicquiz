import { parseSonosChoice, type SonosChoice } from './sonos/bridge';
import { msg } from './i18n';
import type { ConnectTarget } from './spotify/remote';

/**
 * Where the music plays, when not in this browser:
 *  - 'spotify-device': a Spotify Connect device picked under 🔊, like a
 *    speaker, a TV or the Spotify app on a computer or phone.
 *  - 'spotify-app': wherever the Spotify app plays at the moment.
 *    Both are played by src/spotify/remote.ts.
 *  - 'sonos': a Sonos speaker through the Sonos bridge. See src/sonos/.
 */
export type SpeakerChoice =
  | { kind: 'spotify-app' }
  | { kind: 'spotify-device'; device: ConnectTarget }
  | ({ kind: 'sonos' } & SonosChoice);

export const SPOTIFY_APP: SpeakerChoice = { kind: 'spotify-app' };

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** A saved choice, if it has the right shape. Choices saved before 'kind' existed were Sonos ones. */
export function parseSpeakerChoice(v: unknown): SpeakerChoice | null {
  if (!v || typeof v !== 'object') return null;
  const kind = (v as { kind?: unknown }).kind;
  if (kind === 'spotify-app') return SPOTIFY_APP;
  if (kind === 'spotify-device') {
    const d = (v as { device?: Partial<ConnectTarget> }).device;
    if (!d || !isString(d.id) || !isString(d.name)) return null;
    return { kind: 'spotify-device', device: { id: d.id, name: d.name, type: typeof d.type === 'string' ? d.type : '' } };
  }
  const sonos = parseSonosChoice(v);
  return sonos ? { kind: 'sonos', ...sonos } : null;
}

/** A key that changes when the player has to be made again. */
export const speakerKey = (c: SpeakerChoice | null) =>
  !c ? '' : c.kind === 'sonos' ? `sonos:${c.code}:${c.speaker.id}` : c.kind === 'spotify-device' ? `spotify:${c.device.id}` : c.kind;

export const sameSpeaker = (a: SpeakerChoice | null, b: SpeakerChoice | null): boolean => speakerKey(a) === speakerKey(b);

export const speakerLabel = (c: SpeakerChoice | null) =>
  !c ? msg().speakers.thisDevice : c.kind === 'sonos' ? c.speaker.name : c.kind === 'spotify-device' ? c.device.name : msg().speakers.spotifyApp;
