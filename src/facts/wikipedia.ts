import type { Song } from '../game/engine';

/**
 * Fun facts for the reveal screen, read live from English Wikipedia.
 *
 * Wikipedia's API allows calls straight from the browser (`origin=*`) and needs
 * no key, so it works on the static site and for any song, including the
 * player's own Spotify music. For each song we look for the song's own article
 * first and fall back to the artist's article. A result is only used when its
 * title matches what we searched for, so a fact is never about the wrong thing:
 * when nothing matches, no fact is shown.
 */

export interface SongFact {
  /** A few sentences from the start of the article. */
  text: string;
  /** Whether the text is about the song itself or its artist. */
  about: 'song' | 'artist';
  /** The article's title and link, for "Read more". */
  title: string;
  url: string;
}

/** One page from the `generator=search` + `prop=extracts|pageprops` query. */
export interface WikiPage {
  title: string;
  index?: number;
  missing?: boolean;
  extract?: string;
  pageprops?: { disambiguation?: string };
}

const API = 'https://en.wikipedia.org/w/api.php';
const MAX_CHARS = 300;

export function searchUrl(query: string): string {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    origin: '*',
    generator: 'search',
    gsrsearch: query,
    gsrlimit: '6',
    gsrnamespace: '0',
    prop: 'extracts|pageprops',
    ppprop: 'disambiguation',
    exintro: '1',
    explaintext: '1',
    exlimit: 'max',
    redirects: '1',
  });
  return `${API}?${params}`;
}

export function articleUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

/** Lowercase, drop accents, punctuation and "the", for loose title matching. */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the /, '')
    .trim();
}

/** "Hey Jude (song)" -> "Hey Jude"; "Respect (Otis Redding song)" -> "Respect". */
export function baseTitle(articleTitle: string): string {
  return articleTitle.replace(/\s*\([^)]*\)\s*$/, '');
}

/** The song title without Spotify-style suffixes: "Song - 2011 Remaster", "Song (feat. X)". */
export function cleanSongTitle(title: string): string {
  return title
    .replace(/\s+-\s+.*$/, '')
    .replace(/\s*[([](feat\.?|ft\.?|with|from)\b[^)\]]*[)\]]/gi, '')
    .trim();
}

/** The first credited artist: "Marvin Gaye & Tammi Terrell" -> "Marvin Gaye". */
export function mainArtist(artist: string): string {
  return artist.split(/\s*(?:,|&| and | feat\.? | ft\.? | with | x )\s*/i)[0].trim();
}

/**
 * Names to match an artist by: the full credit first, then the first credited
 * artist. The full credit keeps "Earth, Wind & Fire" from turning into "Earth".
 */
export function artistNames(artist: string): string[] {
  return [...new Set([normalize(artist), normalize(mainArtist(artist))])].filter(Boolean);
}

function sortByRank(pages: WikiPage[]): WikiPage[] {
  return pages.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

const usable = (p: WikiPage) => !p.missing && !p.pageprops?.disambiguation && !!p.extract?.trim();

/**
 * The song's own article: its title (without the "(song)" part) matches the
 * song title, and the text names the artist. The artist check is what stops
 * "Respect" from matching the wrong song or a dictionary-style article.
 */
export function pickSongPage(pages: WikiPage[], song: Pick<Song, 'title' | 'artist' | 'from'>): WikiPage | null {
  const title = normalize(cleanSongTitle(song.title));
  const names = artistNames(song.artist);
  if (song.from) names.push(normalize(song.from));
  return (
    sortByRank(pages).find((p) => {
      if (!usable(p) || normalize(baseTitle(p.title)) !== title) return false;
      const text = ` ${normalize(p.extract!)} `;
      return names.some((n) => text.includes(` ${n} `));
    }) ?? null
  );
}

const MUSIC_WORDS =
  /\b(singer|band|musician|rapper|songwriter|group|duo|trio|composer|dj|producer|vocalist|guitarist|pianist|orchestra|recording artist)\b/i;

/**
 * The artist's article: its title matches the artist, it isn't about a song or
 * album, and its first sentence says it's about a musician. That last check
 * keeps "Prince" from picking the article about royalty.
 */
export function pickArtistPage(pages: WikiPage[], artist: string): WikiPage | null {
  const ranked = sortByRank(pages);
  for (const name of artistNames(artist)) {
    const hit = ranked.find((p) => {
      if (!usable(p) || normalize(baseTitle(p.title)) !== name) return false;
      if (/\((.* )?(song|single|album)\)\s*$/i.test(p.title)) return false;
      const firstSentence = p.extract!.split(/\.\s/)[0];
      return MUSIC_WORDS.test(firstSentence);
    });
    if (hit) return hit;
  }
  return null;
}

/**
 * Tidy a plain-text extract and cut it to a few whole sentences. Plain-text
 * extracts keep empty brackets where pronunciation guides were removed.
 */
export function shorten(extract: string, maxChars = MAX_CHARS): string {
  const text = extract
    .split('\n')[0]
    .replace(/\s*\(\s*[;,]?\s*\)/g, '')
    .replace(/\(\s*;\s*/g, '(')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxChars) return text;
  // Split after ., ! or ? followed by a space and a capital letter or quote.
  const sentences = text.match(/[^.!?]+(?:[.!?]+["”’)]?)(?=\s+["“‘(]?[A-Z0-9]|\s*$)|[^.!?]+$/g) ?? [text];
  let out = '';
  for (const s of sentences) {
    if (out && (out + s).length > maxChars) break;
    out += s;
  }
  out = out.trim();
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1).replace(/\s+\S*$/, '')}…`;
  return out;
}

function toFact(page: WikiPage, about: SongFact['about']): SongFact {
  return { text: shorten(page.extract!), about, title: page.title, url: articleUrl(page.title) };
}

type Fetcher = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

async function search(query: string, fetcher: Fetcher): Promise<WikiPage[]> {
  const res = await fetcher(searchUrl(query));
  if (!res.ok) throw new Error(`Wikipedia search failed (${query})`);
  const body = (await res.json()) as { query?: { pages?: WikiPage[] } };
  return body.query?.pages ?? [];
}

/** Look up a fact for a song: its own article, else its artist's. Null when neither is found. */
export async function findFact(song: Song, fetcher: Fetcher = (url) => fetch(url)): Promise<SongFact | null> {
  const title = cleanSongTitle(song.title).replace(/"/g, '');
  const artist = song.artist.replace(/"/g, '');
  const songPage = pickSongPage(await search(`"${title}" ${artist} ${song.from ?? 'song'}`, fetcher), song);
  if (songPage) return toFact(songPage, 'song');
  // Soundtrack songs credited to a composer or cast (John Williams, a musical's
  // cast) are better served by nothing than by a long composer biography.
  if (song.from) return null;
  const artistPage = pickArtistPage(await search(`${artist} musician OR band OR singer`, fetcher), song.artist);
  return artistPage ? toFact(artistPage, 'artist') : null;
}

/**
 * Cached per song for the session. Errors (offline, rate limited) are cached as
 * "no fact" too, so a failing lookup isn't retried on every render.
 */
const cache = new Map<string, Promise<SongFact | null>>();

export function loadFact(song: Song): Promise<SongFact | null> {
  let hit = cache.get(song.id);
  if (!hit) {
    hit = findFact(song).catch(() => null);
    cache.set(song.id, hit);
  }
  return hit;
}
