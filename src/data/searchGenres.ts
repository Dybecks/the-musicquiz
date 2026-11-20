import type { Genre } from './genres';

/**
 * Genres the host can build a list from ("By genre"). `query` is the Spotify
 * genre searched for (and used to build the game's own genre lists);
 * `genre` is the game's wider category, used to mix in its classic hits.
 */
export const SEARCH_GENRES: { id: string; label: string; query: string; genre?: Genre }[] = [
  { id: 'pop', label: 'Pop', query: 'pop', genre: 'pop' },
  { id: 'rock', label: 'Rock', query: 'rock', genre: 'rock' },
  { id: 'hiphop', label: 'Hip-hop', query: 'hip hop', genre: 'hiphop' },
  { id: 'rnb', label: 'R&B', query: 'r&b', genre: 'hiphop' },
  { id: 'soul', label: 'Soul', query: 'soul', genre: 'soul' },
  { id: 'disco', label: 'Disco & funk', query: 'disco', genre: 'soul' },
  { id: 'dance', label: 'Dance', query: 'dance', genre: 'dance' },
  { id: 'country', label: 'Country', query: 'country' },
  { id: 'metal', label: 'Metal', query: 'metal', genre: 'rock' },
  { id: 'indie', label: 'Indie', query: 'indie', genre: 'rock' },
  { id: 'schlager', label: 'Schlager', query: 'schlager', genre: 'swedish' },
  { id: 'swedishpop', label: 'Swedish pop', query: 'swedish pop', genre: 'swedish' },
  { id: 'jazz', label: 'Jazz', query: 'jazz', genre: 'soul' },
  { id: 'reggae', label: 'Reggae', query: 'reggae' },
  { id: 'latin', label: 'Latin', query: 'latin' },
  { id: 'punk', label: 'Punk', query: 'punk', genre: 'rock' },
];
