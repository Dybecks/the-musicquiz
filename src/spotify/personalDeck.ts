/**
 * Pure helpers that turn tracks from someone's Spotify listening into game
 * cards. No network calls here, so the rules are easy to test.
 */
import type { Song } from '../game/engine';
import type { DeckFilter } from '../data/genres';

/** The parts of a Spotify track object the game uses. */
export interface SpotifyTrack {
  id: string | null;
  name: string;
  is_local?: boolean;
  artists: { id: string; name: string }[];
  album: { name?: string; album_type?: string; release_date: string };
}

/** The listening data a person can choose to share. */
export type ListeningSource = 'top' | 'recent' | 'liked';

export const SOURCE_SCOPES: Record<ListeningSource, string> = {
  top: 'user-top-read',
  recent: 'user-read-recently-played',
  liked: 'user-library-read',
};

export const SOURCE_LABELS: Record<ListeningSource, { title: string; detail: string }> = {
  top: { title: 'Top tracks', detail: 'What you play most: last month, last 6 months and the past year.' },
  recent: { title: 'Recently played', detail: 'Your last 50 played tracks.' },
  liked: { title: 'Liked songs', detail: 'Up to 200 of your saved tracks.' },
};

export const ALL_SOURCES: ListeningSource[] = ['top', 'recent', 'liked'];

/**
 * One person's contribution to the deck. The deck holds a list of these so
 * that more people can add their music later (phase two); for now there is at
 * most one.
 */
export interface Contributor {
  userId: string;
  name: string;
  sources: ListeningSource[];
  builtAt: string;
  /** The genres and years the songs were picked for. Missing on decks built by older versions (no filter). */
  filter?: DeckFilter;
  songs: Song[];
}

export interface PersonalDeck {
  version: 1;
  contributors: Contributor[];
}

// Suffixes Spotify adds to a title for a particular release of a song:
// "Song - Remastered 2011", "Song - Radio Edit", "Song (2015 Remaster)".
const RELEASE_WORDS =
  /\b(remaster(ed)?|re-?recorded|version|edit|mono|stereo|mix|live|single|deluxe|anniversary|bonus|demo|from|recorded|taylor's)\b/i;

/** Strips release suffixes such as " - Remastered 2011" from a track title. */
export function cleanTitle(name: string): string {
  let title = name.trim();
  const dash = title.match(/^(.+?)\s+-\s+(.+)$/);
  if (dash && RELEASE_WORDS.test(dash[2])) title = dash[1];
  title = title.replace(/\s*[([]([^)\]]*)[)\]]/g, (whole, inner: string) =>
    RELEASE_WORDS.test(inner) || /^(feat\.?|ft\.?|featuring)\s/i.test(inner) ? '' : whole,
  );
  return title.trim() || name.trim();
}

/** Lower-case letters and digits only, for comparing titles and artists. */
export function normalizeKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function songKey(title: string, artist: string): string {
  const firstArtist = artist.split(/\s*(?:,|&|feat\.|ft\.)\s*/i)[0];
  return `${normalizeKey(cleanTitle(title))}|${normalizeKey(firstArtist)}`;
}

/** The year from a Spotify release date ("1975", "1975-10", "1975-10-31"), or null. */
export function releaseYear(date: string | undefined, now = new Date()): number | null {
  const year = Number.parseInt(date?.slice(0, 4) ?? '', 10);
  if (!Number.isFinite(year) || year < 1900 || year > now.getFullYear() + 1) return null;
  return year;
}

function isPlayable(track: SpotifyTrack | null | undefined): track is SpotifyTrack & { id: string } {
  return !!track && !!track.id && !track.is_local && track.artists?.length > 0;
}

/** Removes local files and repeats (the same track id, or the same song in another release). */
export function uniqueTracks(tracks: (SpotifyTrack | null | undefined)[]): (SpotifyTrack & { id: string })[] {
  const seenIds = new Set<string>();
  const seenSongs = new Set<string>();
  const out: (SpotifyTrack & { id: string })[] = [];
  for (const track of tracks) {
    if (!isPlayable(track) || seenIds.has(track.id)) continue;
    const key = songKey(track.name, track.artists[0].name);
    seenIds.add(track.id);
    if (seenSongs.has(key)) continue;
    seenSongs.add(key);
    out.push(track);
  }
  return out;
}

/**
 * Spotify dates a track by the album it is on, so a 1975 song on a 2011
 * remaster or a greatest-hits album says 2011. Given search results for the
 * same song, returns the earliest year it was released by the same artist.
 */
export function earliestYear(track: SpotifyTrack, candidates: SpotifyTrack[]): number | null {
  const ownYear = releaseYear(track.album.release_date);
  const title = normalizeKey(cleanTitle(track.name));
  const artistId = track.artists[0]?.id;
  let best = ownYear;
  for (const c of candidates) {
    if (!c.artists?.some((a) => a.id === artistId)) continue;
    if (normalizeKey(cleanTitle(c.name)) !== title) continue;
    const year = releaseYear(c.album?.release_date);
    if (year !== null && (best === null || year < best)) best = year;
  }
  return best;
}

/**
 * Whether a track can still fall inside the year span before its original
 * year is known. The album year is never earlier than the original release,
 * so an album from before the span rules the song out; a later album doesn't.
 */
export function couldMatchYears(track: SpotifyTrack, filter: Pick<DeckFilter, 'fromYear'>): boolean {
  const year = releaseYear(track.album.release_date);
  return filter.fromYear === null || year === null || year >= filter.fromYear;
}

export function trackToSong(track: SpotifyTrack & { id: string }, year: number): Song {
  return {
    id: `sp:${track.id}`,
    title: cleanTitle(track.name),
    artist: track.artists
      .slice(0, 2)
      .map((a) => a.name)
      .join(', '),
    year,
    spotifyId: track.id,
  };
}

/** Joins song lists, keeping the first copy of any song that appears twice. */
export function mergeSongs(...lists: readonly (readonly Song[])[]): Song[] {
  const ids = new Set<string>();
  const keys = new Set<string>();
  const out: Song[] = [];
  for (const song of lists.flat()) {
    const key = songKey(song.title, song.artist);
    if (keys.has(key) || (song.spotifyId && ids.has(song.spotifyId))) continue;
    keys.add(key);
    if (song.spotifyId) ids.add(song.spotifyId);
    out.push(song);
  }
  return out;
}

export function personalSongs(deck: PersonalDeck | null): Song[] {
  return deck ? mergeSongs(...deck.contributors.map((c) => c.songs)) : [];
}

export interface DeckSummary {
  count: number;
  minYear: number | null;
  maxYear: number | null;
  /** Number of songs per decade, e.g. { 1970: 12, 2010: 40 }, oldest first. */
  decades: [decade: number, count: number][];
}

export function summarize(songs: readonly Song[]): DeckSummary {
  const decades = new Map<number, number>();
  for (const s of songs) {
    const d = Math.floor(s.year / 10) * 10;
    decades.set(d, (decades.get(d) ?? 0) + 1);
  }
  const years = songs.map((s) => s.year);
  return {
    count: songs.length,
    minYear: years.length ? Math.min(...years) : null,
    maxYear: years.length ? Math.max(...years) : null,
    decades: [...decades.entries()].sort((a, b) => a[0] - b[0]),
  };
}
