import type { Genre } from './genres';

export interface SearchGenre {
  id: string;
  /** The Spotify genre searched for (and used to build the game's own genre lists). */
  query: string;
  /** The game's wider category, used to mix in its classic hits. */
  genre?: Genre;
}

/**
 * Genres the host can build a list from ("By genre"). Labels live in
 * src/i18n (searchGenres); SEARCH_GENRES in src/spotify/listening.ts adds them.
 */
export const SEARCH_GENRE_DEFS: SearchGenre[] = [
  { id: 'pop', query: 'pop', genre: 'pop' },
  { id: 'rock', query: 'rock', genre: 'rock' },
  { id: 'hiphop', query: 'hip hop', genre: 'hiphop' },
  { id: 'rnb', query: 'r&b', genre: 'hiphop' },
  { id: 'soul', query: 'soul', genre: 'soul' },
  { id: 'disco', query: 'disco', genre: 'soul' },
  { id: 'dance', query: 'dance', genre: 'dance' },
  { id: 'country', query: 'country' },
  { id: 'metal', query: 'metal', genre: 'rock' },
  { id: 'indie', query: 'indie', genre: 'rock' },
  { id: 'schlager', query: 'schlager', genre: 'swedish' },
  { id: 'swedishpop', query: 'swedish pop', genre: 'swedish' },
  { id: 'jazz', query: 'jazz', genre: 'soul' },
  { id: 'reggae', query: 'reggae' },
  { id: 'latin', query: 'latin' },
  { id: 'punk', query: 'punk', genre: 'rock' },
];
