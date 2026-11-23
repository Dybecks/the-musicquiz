import type { Song } from '../game/engine';
import { baseTitle, normalize } from './wikipedia';

/**
 * The picture on the reveal screen.
 *
 * - Soundtrack songs (with `from`): the film's, show's, game's or musical's
 *   main image on English Wikipedia (usually its poster, cover art or logo).
 *   English Wikipedia is used in every language: it has the most posters, and a
 *   poster reads the same in Swedish.
 * - Every other song, and soundtrack songs whose work isn't found: the album
 *   cover, from Spotify's public oEmbed endpoint. It needs no login and doesn't
 *   use the Spotify Web API quota.
 *
 * Both answer browser requests from any site (CORS), so this works on the
 * static site and on the phones. Looked up once per song per session; when
 * nothing is found (or the network fails) the reveal simply shows no picture.
 */

export interface Artwork {
  url: string;
  /** What the picture shows: the soundtrack's work, or the song's album. */
  kind: 'work' | 'album';
}

/** One page from the `generator=search` + `prop=pageimages|pageprops|description` query. */
export interface WorkPage {
  title: string;
  index?: number;
  missing?: boolean;
  description?: string;
  thumbnail?: { source: string };
  pageprops?: { disambiguation?: string };
}

/** Short descriptions of films, shows, games and stage works ("2023 film by Greta Gerwig"). */
const WORK =
  /\b(film|films|movie|series|sitcom|show|programme|program|soap opera|anime|cartoon|animated|miniseries|drama|television|tv|game|musical|opera|rock opera|stage|play|franchise)\b/i;
/** Pages about something around the work, not the work: "Minecraft: The Story of Mojang" (documentary film). */
const NOT_WORK = /\b(documentary|soundtrack|episode|season|character)\b/i;

export function workSearchUrl(song: Pick<Song, 'from' | 'year'>): string {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    origin: '*',
    generator: 'search',
    gsrsearch: `"${(song.from ?? '').replace(/"/g, '')}" ${song.year}`,
    gsrlimit: '10',
    gsrnamespace: '0',
    prop: 'pageimages|pageprops|description',
    piprop: 'thumbnail',
    pithumbsize: '400',
    // Posters and cover art are non-free files; the default only returns free ones.
    pilicense: 'any',
    ppprop: 'disambiguation',
    redirects: '1',
  });
  return `https://en.wikipedia.org/w/api.php?${params}`;
}

/** Title key for matching: "Frozen II" and "Frozen 2" are the same work. */
function workKey(title: string): string {
  return normalize(title)
    .replace(/ iii$/, ' 3')
    .replace(/ ii$/, ' 2');
}

/**
 * The year a page is about: the one in its title ("Doom (2016 video game)"),
 * else the first in its short description ("2007 musical based on the 1989
 * film" is 2007). Null when neither names one.
 */
export function pageYear(page: Pick<WorkPage, 'title' | 'description'>): number | null {
  const paren = page.title.match(/\(([^)]*)\)\s*$/)?.[1] ?? '';
  const year = paren.match(/\b(1[89]\d\d|20\d\d)\b/) ?? (page.description ?? '').match(/\b(1[89]\d\d|20\d\d)\b/);
  return year ? Number(year[1]) : null;
}

/**
 * The work's own article. It must:
 *  - be titled like `from`, apart from a "(film)" part or a ": subtitle"
 *    ("Sweeney Todd: The Demon Barber of Fleet Street");
 *  - have a short description saying it is a film, show, game or stage work
 *    (not a documentary, soundtrack or episode about it), so "Barbie" the
 *    doll is skipped for "Barbie (film)";
 *  - not be about another year: the 2008 "Knight Rider" or the 2007 stage
 *    "Little Mermaid" are skipped for the 1982 show and the 1989 film. Two
 *    years apart is allowed (a concept album came first, as for Evita);
 *  - have an image.
 * Exact titles beat subtitled ones, a matching year beats no year, then the best search hit.
 */
export function pickWorkPage(pages: WorkPage[], song: Pick<Song, 'from' | 'year'>): WorkPage | null {
  if (!song.from) return null;
  const want = workKey(song.from);
  const rank = (p: WorkPage): number | null => {
    if (p.missing || p.pageprops?.disambiguation !== undefined || !p.thumbnail?.source) return null;
    if (!WORK.test(p.description ?? '') || NOT_WORK.test(p.description ?? '')) return null;
    const base = baseTitle(p.title);
    const exact = workKey(base) === want;
    if (!exact && !(base.includes(':') && workKey(base.split(':')[0]) === want)) return null;
    const year = pageYear(p);
    if (year !== null && Math.abs(year - song.year) > 2) return null;
    return (exact ? 0 : 2) + (year === null ? 1 : 0);
  };
  return (
    pages
      .map((p) => ({ p, r: rank(p) }))
      .filter((x): x is { p: WorkPage; r: number } => x.r !== null)
      .sort((a, b) => a.r - b.r || (a.p.index ?? 0) - (b.p.index ?? 0))[0]?.p ?? null
  );
}

export function oembedUrl(spotifyId: string): string {
  return `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${spotifyId}`)}`;
}

/** The Spotify track id: `spotifyId`, or the id of a catalogue/playlist song (`sp:<id>`). */
export function spotifyIdOf(song: Pick<Song, 'id' | 'spotifyId'>): string | null {
  if (song.spotifyId) return song.spotifyId;
  return song.id.startsWith('sp:') ? song.id.slice(3) : null;
}

type Fetcher = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

async function workImage(song: Song, fetcher: Fetcher): Promise<string | null> {
  const res = await fetcher(workSearchUrl(song));
  if (!res.ok) return null;
  const body = (await res.json()) as { query?: { pages?: WorkPage[] } };
  return pickWorkPage(body.query?.pages ?? [], song)?.thumbnail?.source ?? null;
}

async function albumImage(song: Song, fetcher: Fetcher): Promise<string | null> {
  const id = spotifyIdOf(song);
  if (!id) return null;
  const res = await fetcher(oembedUrl(id));
  if (!res.ok) return null;
  const body = (await res.json()) as { thumbnail_url?: string };
  return body.thumbnail_url ?? null;
}

/** Find the picture for a song: the work for soundtracks, else (or failing that) the album. */
export async function findArtwork(song: Song, fetcher: Fetcher = (url) => fetch(url)): Promise<Artwork | null> {
  if (song.from) {
    const url = await workImage(song, fetcher).catch(() => null);
    if (url) return { url, kind: 'work' };
  }
  const url = await albumImage(song, fetcher).catch(() => null);
  return url ? { url, kind: 'album' } : null;
}

const cache = new Map<string, Promise<Artwork | null>>();

/**
 * The reveal picture, looked up once per song for the session. Starting it
 * while the song plays also warms the browser's image cache, so the picture
 * is there at the reveal.
 */
export function loadArtwork(song: Song, lookup: (song: Song) => Promise<Artwork | null> = findArtwork): Promise<Artwork | null> {
  let hit = cache.get(song.id);
  if (!hit) {
    hit = lookup(song)
      .catch(() => null)
      .then((art) => {
        if (art && typeof Image !== 'undefined') new Image().src = art.url;
        return art;
      });
    cache.set(song.id, hit);
  }
  return hit;
}
