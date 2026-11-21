import type { Genre } from './genres';

export interface SearchGenre {
  id: string;
  /** The game's wider category, used to mix in its classic hits. */
  genre?: Genre;
}

/**
 * Genres the host can build a list from ("By genre"). Labels live in
 * src/i18n (searchGenres); SEARCH_GENRES in src/spotify/listening.ts adds them.
 */
export const SEARCH_GENRE_DEFS: SearchGenre[] = [
  { id: 'pop', genre: 'pop' },
  { id: 'rock', genre: 'rock' },
  { id: 'hiphop', genre: 'hiphop' },
  { id: 'rnb', genre: 'hiphop' },
  { id: 'soul', genre: 'soul' },
  { id: 'disco', genre: 'soul' },
  { id: 'dance', genre: 'dance' },
  { id: 'country' },
  { id: 'metal', genre: 'rock' },
  { id: 'indie', genre: 'rock' },
  { id: 'schlager', genre: 'swedish' },
  { id: 'swedishpop', genre: 'swedish' },
  { id: 'jazz', genre: 'soul' },
  { id: 'reggae' },
  { id: 'latin' },
  { id: 'punk', genre: 'rock' },
];
