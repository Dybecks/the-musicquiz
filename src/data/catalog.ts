/**
 * The song catalogue: every song the game knows, one row each, in
 * src/data/catalog/songs.json. A row has the song's Spotify track id, title,
 * artist, original release year (single or album, whichever came first),
 * genres (the "By genre" ids in searchGenres.ts) and, for soundtracks, the
 * film, show, game or musical it is from.
 *
 * The ready-made decks (src/data/catalog/decks.json) are lists of Spotify ids
 * from the catalogue. "By genre" picks straight from the whole catalogue.
 *
 * To add a song: add a row with "id": null and run `npm run spotify-data`
 * (scripts/spotify-precompute.ts), which looks up the id. Rows without an id
 * stay out of the game until then.
 */
import type { Song } from '../game/engine';
import type { Genre } from './genres';
import SONGS from './catalog/songs.json';
import DECK_IDS from './catalog/decks.json';
import { SEARCH_GENRE_DEFS } from './searchGenres';

export interface CatalogRow {
  /** Spotify track id; null until scripts/spotify-precompute.ts has looked it up. */
  id: string | null;
  title: string;
  artist: string;
  year: number;
  /** "By genre" ids (SEARCH_GENRE_DEFS). */
  genres: string[];
  /** The film, show, game or musical the song is from. */
  from?: string;
}

export type BuiltInDeckId = 'classic' | 'movies' | 'musicals' | 'tv' | 'games';

export const CATALOG_ROWS = SONGS as CatalogRow[];
export const DECK_LISTS = DECK_IDS as Record<BuiltInDeckId, string[]>;

const WIDER = new Map(SEARCH_GENRE_DEFS.map((g) => [g.id, g.genre]));

/** The game's wider genres (used by the genre filter) for catalogue genres. */
export function widerGenres(genres: readonly string[]): Genre[] {
  return [...new Set(genres.map((g) => WIDER.get(g)).filter((g): g is Genre => !!g))];
}

function toSong(row: CatalogRow & { id: string }): Song {
  return {
    id: `sp:${row.id}`,
    title: row.title,
    artist: row.artist,
    year: row.year,
    spotifyId: row.id,
    genres: widerGenres(row.genres),
    ...(row.from ? { from: row.from } : {}),
  };
}

const playable = CATALOG_ROWS.filter((r): r is CatalogRow & { id: string } => !!r.id);
const BY_ID = new Map(playable.map((r) => [r.id, toSong(r)]));

/** Every song in the catalogue that can be played (has a Spotify id). */
export const CATALOG: Song[] = [...BY_ID.values()];

/** The songs of a ready-made deck, in the deck's order. */
export function deckFromCatalog(id: BuiltInDeckId): Song[] {
  return DECK_LISTS[id].map((sid) => BY_ID.get(sid)).filter((s): s is Song => !!s);
}

/** Catalogue songs in any of these genres ("By genre" ids) from these years. */
export function catalogSongs(genreIds: readonly string[], from: number, to: number): Song[] {
  return playable
    .filter((r) => r.year >= from && r.year <= to && r.genres.some((g) => genreIds.includes(g)))
    .map((r) => BY_ID.get(r.id)!);
}
