/**
 * Pure helpers that turn tracks from someone's Spotify listening into game
 * cards. No network calls here, so the rules are easy to test.
 */
import type { Song } from '../game/engine';
import type { DeckFilter } from '../data/genres';
import { msg } from '../i18n';

/** The parts of a Spotify track object the game uses. */
export interface SpotifyTrack {
  id: string | null;
  name: string;
  is_local?: boolean;
  artists: { id: string; name: string }[];
  album: { name?: string; album_type?: string; release_date: string };
}

/** The listening data a person can choose to share. */
export type ListeningSource = 'top' | 'recent' | 'liked' | 'playlists';

export const SOURCE_SCOPES: Record<ListeningSource, string> = {
  top: 'user-top-read',
  recent: 'user-read-recently-played',
  liked: 'user-library-read',
  playlists: 'playlist-read-private',
};

/** The texts for each source, in the current language (src/i18n). */
export const sourceLabel = (source: ListeningSource): { title: string; detail: string } => msg().sources[source];

export const ALL_SOURCES: ListeningSource[] = ['top', 'recent', 'liked', 'playlists'];

/**
 * One person's contribution to the deck. The deck holds a list of these so
 * that more people can add their music later (phase two); for now there is at
 * most one.
 */
export interface Contributor {
  /** 'host' is the person running the game; 'friend' added their music with their own login. Missing means host. */
  role?: 'host' | 'friend';
  userId: string;
  name: string;
  sources: ListeningSource[];
  builtAt: string;
  /** The genres and years the songs were picked for. Missing on decks built by older versions (no filter). */
  filter?: DeckFilter;
  /** What the list was built from, for example "Pop, Rock · 1970–1999". */
  label?: string;
  songs: Song[];
  /** Where more songs come from while playing (a RefillPlan from listening.ts). */
  plan?: unknown;
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

/** The host's own music, if loaded. */
export function hostContributor(deck: PersonalDeck | null): Contributor | undefined {
  return deck?.contributors.find((c) => c.role !== 'friend');
}

export function friendContributors(deck: PersonalDeck | null): Contributor[] {
  return deck?.contributors.filter((c) => c.role === 'friend') ?? [];
}

/**
 * Adds one person's music, replacing what the same Spotify account added
 * before. There is one host: new host music replaces the old host's.
 */
export function withContributor(deck: PersonalDeck | null, contributor: Contributor): PersonalDeck {
  const role = contributor.role ?? 'host';
  const others = (deck?.contributors ?? []).filter(
    (c) => c.userId !== contributor.userId && !(role === 'host' && (c.role ?? 'host') === 'host'),
  );
  const contributors = role === 'host' ? [contributor, ...others] : [...others, contributor];
  return { version: 1, contributors };
}

export function withoutContributor(deck: PersonalDeck | null, userId: string): PersonalDeck | null {
  const contributors = (deck?.contributors ?? []).filter((c) => c.userId !== userId);
  return contributors.length ? { version: 1, contributors } : null;
}

// Album names that suggest a later release of older songs.
const REISSUE_WORDS =
  /\b(remaster(ed)?|deluxe|anniversary|expanded|edition|greatest|best of|hits|collection|essential|anthology|definitive|ultimate|gold|platinum|classics|reissue|live|years|retrospective|complete|the very best)\b/i;

/**
 * Whether the album year may be later than the song's first release, so the
 * original year has to be searched for. Songs on their original album or
 * single are dated by the album, which saves a search per song.
 */
export function needsYearCheck(track: SpotifyTrack): boolean {
  if (track.album.album_type === 'compilation') return true;
  if (REISSUE_WORDS.test(track.album.name ?? '')) return true;
  return cleanTitle(track.name) !== track.name.trim();
}

/**
 * Picks at most `max` items, spread as evenly as possible over the decades:
 * one from each decade in turn, keeping the original order within a decade.
 * Items with no known year form their own group.
 */
export function spreadPick<T>(items: readonly T[], max: number, yearOf: (item: T) => number | null): T[] {
  if (items.length <= max) return items.slice();
  const groups = new Map<number | null, T[]>();
  for (const item of items) {
    const y = yearOf(item);
    const key = y === null ? null : Math.floor(y / 10) * 10;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const lists = [...groups.values()];
  const out: T[] = [];
  for (let round = 0; out.length < max; round++) {
    let added = false;
    for (const list of lists) {
      if (round < list.length && out.length < max) {
        out.push(list[round]);
        added = true;
      }
    }
    if (!added) break;
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
