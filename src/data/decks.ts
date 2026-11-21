import type { Song } from '../game/engine';
import type { PlaybackKind } from '../spotify/playback';
import { mergeSongs, personalSongs, type PersonalDeck } from '../spotify/personalDeck';
import { deckFromCatalog, type BuiltInDeckId } from './catalog';
import { filterSongs, NO_FILTER, type DeckFilter } from './genres';
import { msg } from '../i18n';

/** The decks a game can be played with. Any combination can be chosen. */
export type DeckId = 'classic' | 'movies' | 'musicals' | 'tv' | 'games' | 'mine';

export interface DeckInfo {
  id: DeckId;
  readonly title: string;
  readonly detail: string;
}

/** The decks, in order. Titles and details are in the current language (src/i18n). */
export const DECKS: DeckInfo[] = (['classic', 'movies', 'musicals', 'tv', 'games', 'mine'] as const).map((id) => ({
  id,
  get title() {
    return msg().decks[id].title;
  },
  get detail() {
    return msg().decks[id].detail;
  },
}));

/** The ready-made decks: lists of songs from the catalogue (src/data/catalog). */
export const BUILT_IN: Record<BuiltInDeckId, Song[]> = {
  classic: deckFromCatalog('classic'),
  movies: deckFromCatalog('movies'),
  musicals: deckFromCatalog('musicals'),
  tv: deckFromCatalog('tv'),
  games: deckFromCatalog('games'),
};

const ALL_IDS = DECKS.map((d) => d.id);

/** Keeps known ids, in the order of DECKS, and falls back to the classic deck. */
export function normalizeDecks(ids: readonly string[]): DeckId[] {
  const out = ALL_IDS.filter((id) => ids.includes(id));
  return out.length ? out : ['classic'];
}

/** Reads a saved choice, including the single values saved by earlier versions. */
export function parseSavedDecks(saved: string | null): DeckId[] {
  if (saved === 'mix') return ['classic', 'mine'];
  if (saved === 'classic' || saved === 'mine') return [saved];
  try {
    const parsed = JSON.parse(saved ?? 'null');
    if (Array.isArray(parsed)) return normalizeDecks(parsed);
  } catch {
    /* ignore */
  }
  return ['classic'];
}

export function deckSongs(id: DeckId, personal: PersonalDeck | null): Song[] {
  return id === 'mine' ? personalSongs(personal) : BUILT_IN[id];
}

/**
 * Without a login, the hidden player can only play songs with a known Spotify
 * id. Every other combination can look songs up by search.
 */
export function playableSongs(songs: readonly Song[], mode: PlaybackKind, loggedIn: boolean): Song[] {
  return mode === 'embed' && !loggedIn ? songs.filter((s) => s.spotifyId) : songs.slice();
}

export interface DeckOptions {
  decks: readonly DeckId[];
  mode: PlaybackKind;
  loggedIn: boolean;
  personal: PersonalDeck | null;
  /** Genres and years to keep. */
  filter?: DeckFilter;
}

/** All playable songs from the chosen decks, without duplicates, narrowed by genre and year. */
export function chooseSongs({ decks, mode, loggedIn, personal, filter = NO_FILTER }: DeckOptions): Song[] {
  // The person's own songs go first: they carry Spotify ids, so their copy wins.
  const ordered = [...decks].sort((a, b) => Number(b === 'mine') - Number(a === 'mine'));
  return filterSongs(mergeSongs(...ordered.map((id) => playableSongs(deckSongs(id, personal), mode, loggedIn))), filter);
}
