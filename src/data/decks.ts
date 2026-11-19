import type { Song } from '../game/engine';
import type { PlaybackKind } from '../spotify/playback';
import { mergeSongs, personalSongs, type PersonalDeck } from '../spotify/personalDeck';
import { DEFAULT_SONGS, NO_LOGIN_SONGS } from './songs';

/** Which songs the game is played with. */
export type DeckChoice = 'classic' | 'mine' | 'mix';

export interface DeckOptions {
  choice: DeckChoice;
  mode: PlaybackKind;
  loggedIn: boolean;
  personal: PersonalDeck | null;
}

/** The built-in deck, limited to songs with a known Spotify id when the hidden player has no login. */
export function classicSongs(mode: PlaybackKind, loggedIn: boolean): Song[] {
  return mode === 'embed' && !loggedIn ? NO_LOGIN_SONGS : DEFAULT_SONGS;
}

/**
 * Songs from someone's Spotify always carry a track id, so they play in every
 * mode, also after logging out.
 */
export function chooseSongs({ choice, mode, loggedIn, personal }: DeckOptions): Song[] {
  const mine = personalSongs(personal);
  if (choice === 'classic' || mine.length === 0) return classicSongs(mode, loggedIn);
  if (choice === 'mine') return mine;
  return mergeSongs(mine, classicSongs(mode, loggedIn));
}
