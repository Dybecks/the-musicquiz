import { parseSonosChoice, type SonosChoice } from './sonos/bridge';
import { msg } from './i18n';

/**
 * Where the music plays, when not in this browser:
 *  - 'spotify-app': the game steers the Spotify app, which plays wherever it
 *    plays (the phone, or a speaker picked in the app). See src/spotify/remote.ts.
 *  - 'sonos': a Sonos speaker through the Sonos bridge. See src/sonos/.
 */
export type SpeakerChoice = { kind: 'spotify-app' } | ({ kind: 'sonos' } & SonosChoice);

export const SPOTIFY_APP: SpeakerChoice = { kind: 'spotify-app' };

/** A saved choice, if it has the right shape. Choices saved before 'kind' existed were Sonos ones. */
export function parseSpeakerChoice(v: unknown): SpeakerChoice | null {
  if (v && typeof v === 'object' && (v as { kind?: unknown }).kind === 'spotify-app') return SPOTIFY_APP;
  const sonos = parseSonosChoice(v);
  return sonos ? { kind: 'sonos', ...sonos } : null;
}

export const sameSpeaker = (a: SpeakerChoice | null, b: SpeakerChoice | null): boolean =>
  !a || !b ? a === b : a.kind === 'sonos' && b.kind === 'sonos' ? a.code === b.code && a.speaker.id === b.speaker.id : a.kind === b.kind;

/** A key that changes when the player has to be made again. */
export const speakerKey = (c: SpeakerChoice | null) => (!c ? '' : c.kind === 'sonos' ? `sonos:${c.code}:${c.speaker.id}` : c.kind);

export const speakerLabel = (c: SpeakerChoice | null) => (!c ? msg().speakers.thisDevice : c.kind === 'sonos' ? c.speaker.name : msg().speakers.spotifyApp);
