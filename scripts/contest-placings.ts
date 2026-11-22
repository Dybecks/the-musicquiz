/**
 * The schlager songs, as Markus defined them on 2026-11-22: the top 3 of every Eurovision final,
 * every Swedish Eurovision entry, and the top 3 of every Melodifestivalen final. Nothing else.
 *
 * Read from Wikipedia's tables, which are complete where Wikidata is not: English Wikipedia's
 * "Eurovision Song Contest YYYY" (the final) and "Sweden in the Eurovision Song Contest" (every
 * entry), and Swedish Wikipedia's "Melodifestivalen YYYY" (the final). Free, no Spotify requests.
 */

const agent = { 'User-Agent': 'the-musicquiz-precompute/1.0 (https://github.com/Dybecks/the-musicquiz)' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ContestSong {
  title: string;
  artist: string;
  year: number;
  /** Why it counts, e.g. "Eurovision 2nd", "Sweden at Eurovision 5th", "Melodifestivalen 1st". */
  via: string[];
  /** Other titles of the same song: Sweden's Eurovision version ("Boogaloo" for "Fyra Bugg & en Coca Cola"). */
  aka: string[];
}

export interface ContestYear {
  year: number;
  eurovision: { place: number; title: string; artist: string; country: string }[];
  sweden: { place: string; title: string; artist: string } | null;
  melodifestivalen: { place: number; title: string; artist: string }[];
}

// ---- Wikipedia tables ----

interface Cell {
  th: boolean;
  text: string;
}
interface Table {
  section: string;
  rows: Cell[][];
}

const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const plain = (html: string) =>
  decode(
    html
      .replace(/<sup[\s\S]*?<\/sup>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<br\s*\/?>/g, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
/** Without quotes and Wikipedia's table marks (◇ cancelled, ◁ last place, † ‡ notes). */
const unquote = (s: string) => s.replace(/[◇◁▷†‡*]/g, '').replace(/^["“”\s]+|["“”\s]+$/g, '').trim();

/** The page's wikitables, each with the heading it stands under. */
function tables(html: string): Table[] {
  const out: Table[] = [];
  let section = '';
  for (const m of html.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>|<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>([\s\S]*?)<\/table>/g)) {
    if (m[1] !== undefined) {
      section = plain(m[1]);
      continue;
    }
    const rows = [...m[2].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) =>
      [...r[1].matchAll(/<(t[hd])[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => ({ th: c[1] === 'th', text: plain(c[2]) })),
    );
    out.push({ section, rows });
  }
  return out;
}

async function page(lang: 'en' | 'sv', title: string): Promise<string> {
  const url = `https://${lang}.wikipedia.org/w/api.php?${new URLSearchParams({ action: 'parse', page: title, prop: 'text', format: 'json', formatversion: '2', redirects: '1' })}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: agent, signal: AbortSignal.timeout(30_000) });
      await sleep(300);
      return ((await res.json()) as { parse?: { text?: string } }).parse?.text ?? '';
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(5000);
    }
  }
}

/**
 * The rows of a results table: the column under `song` and the place, read from the end of the
 * row, because row-spanning cells and two-row headings shift columns at the start but not the end.
 * Every results table on the page, in page order (finals come after heats and semi-finals).
 */
function results(html: string, words: { song: RegExp; place: RegExp; artist: RegExp; country?: RegExp }) {
  const all = tables(html);
  // Artists listed in a separate start list ("Nr / Artist / Låt"), by song title.
  const artistOf = new Map<string, string>();
  for (const t of all) {
    const head = t.rows.find((r) => r.some((c) => words.song.test(c.text)) && r.some((c) => words.artist.test(c.text)));
    if (!head) continue;
    const s = head.findIndex((c) => words.song.test(c.text));
    const a = head.findIndex((c) => words.artist.test(c.text));
    for (const r of t.rows) if (r.length === head.length && r.some((c) => !c.th)) artistOf.set(key(unquote(r[s].text)), r[a].text);
  }
  const found: { place: number; title: string; artist: string; country: string }[][] = [];
  for (const t of all) {
    const hi = t.rows.findIndex((r) => r.some((c) => words.song.test(c.text)));
    if (hi < 0) continue;
    // The place may sit in a second heading row, under a heading that spans sub-columns.
    const placeRow = t.rows.slice(hi, hi + 3).find((r) => r.some((c) => words.place.test(c.text)));
    if (!placeRow) continue;
    const head = t.rows[hi].map((c) => c.text);
    const fromEnd = (i: number, row: unknown[]) => row.length - 1 - i;
    const p = fromEnd(placeRow.findIndex((c) => words.place.test(c.text)), placeRow);
    const s = head.findIndex((x) => words.song.test(x));
    const sFromEnd = fromEnd(s, head);
    const a = head.findIndex((x) => words.artist.test(x));
    const c = words.country ? head.findIndex((x) => words.country!.test(x)) : -1;
    const rows = t.rows
      .slice(hi + 1)
      // A data row has at least one plain cell (Eurovision tables mark the country as a row heading).
      .filter((r) => r.some((cell) => !cell.th) && r.length >= 2)
      .map((r) => {
        // A row missing its leading cells (a spanned country or number) still ends the same way;
        // a longer one (votes under a spanning heading) still starts the same way.
        const at = (i: number) => (r.length >= head.length ? r[i] : r[r.length - 1 - fromEnd(i, head)])?.text ?? '';
        const title = unquote(r.length >= head.length ? r[s].text : (r[r.length - 1 - sFromEnd]?.text ?? ''));
        return {
          place: parseInt(r[r.length - 1 - p]?.text ?? '', 10),
          title,
          artist: unquote(a >= 0 ? at(a) : (artistOf.get(key(title)) ?? '')),
          country: c >= 0 ? at(c) : '',
        };
      })
      .filter((r) => r.title && r.place > 0);
    if (rows.length) found.push(rows);
  }
  return found;
}

const key = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

const EUROVISION = { song: /^song$/i, place: /^(place|pl\.?)$/i, artist: /^(artist|performer)/i, country: /^(country|nation)/i };
const MELODIFESTIVALEN = { song: /^(låt|bidrag|titel|sång|melodi)\b/i, place: /^(plac\.?|placering|plats)$/i, artist: /^artist/i };

// ---- The list ----

export async function contestSongs(firstYear = 1956, lastYear = new Date().getFullYear()): Promise<{ songs: ContestSong[]; years: ContestYear[] }> {
  const years: ContestYear[] = [];
  // Every Swedish entry, with its place in the final (or how far it got).
  const swedenPage = tables(await page('en', 'Sweden in the Eurovision Song Contest'));
  const sweden = new Map<number, ContestYear['sweden']>();
  for (const t of swedenPage) {
    const head = t.rows[0]?.map((c) => c.text) ?? [];
    const y = head.indexOf('Year');
    const s = head.indexOf('Song');
    const a = head.indexOf('Artist');
    const f = head.indexOf('Final');
    if (y < 0 || s < 0 || a < 0 || f < 0 || sweden.size) continue;
    for (const r of t.rows.slice(1)) {
      const year = parseInt(r[y]?.text ?? '', 10);
      if (year > 0 && r[s]) sweden.set(year, { place: r[f]?.text ?? '', title: unquote(r[s].text), artist: unquote(r[a]?.text ?? '') });
    }
  }
  for (let year = firstYear; year <= lastYear; year++) {
    // The Eurovision final is the page's biggest results table; 1956 gave only a winner.
    const esc =
      year === 1956
        ? [{ place: 1, title: 'Refrain', artist: 'Lys Assia', country: 'Switzerland' }]
        : year === 2020
          ? []
          : results(await page('en', `Eurovision Song Contest ${year}`), EUROVISION).reduce((a, b) => (b.length > a.length ? b : a), []);
    // The Melodifestivalen final is the last results table, or, when a year has several (1993 had a
    // jury round after the public vote), the one whose winner went to Eurovision.
    const sent = sweden.get(year);
    const mfTables = year < 1959 ? [] : results(await page('sv', `Melodifestivalen ${year}`), MELODIFESTIVALEN);
    const mf = [...mfTables].reverse().find((t) => sent && t.some((r) => r.place === 1 && key(r.title) === key(sent.title))) ?? mfTables.at(-1) ?? [];
    // A winner without an artist (one singer did every song in 1965) is the one who went on.
    for (const r of mf) if (r.place === 1 && !r.artist && sent) r.artist = sent.artist;
    years.push({
      year,
      eurovision: esc.filter((r) => r.place <= 3).sort((x, y) => x.place - y.place),
      sweden: sweden.get(year) ?? null,
      melodifestivalen: mf.filter((r) => r.place <= 3 && r.artist).sort((x, y) => x.place - y.place),
    });
  }

  const ordinal = (n: number | string) => {
    const i = Number(n);
    if (!Number.isInteger(i) || i <= 0) return String(n);
    return `${i}${i % 100 >= 11 && i % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[i % 10] ?? 'th'}`;
  };
  const songs = new Map<string, ContestSong>();
  const add = (title: string, artist: string, year: number, via: string) => {
    const k = `${key(title)}|${year}`;
    const had = songs.get(k);
    if (had) {
      if (!had.via.includes(via)) had.via.push(via);
    } else songs.set(k, { title, artist, year, via: [via], aka: [] });
  };
  for (const y of years) {
    for (const r of y.eurovision) add(r.title, r.artist, y.year, `Eurovision ${ordinal(r.place)}`);
    // Sweden's entry is that year's Melodifestivalen winner, sometimes under an English title or
    // another singer ("Fyra Bugg & en Coca Cola" went to Eurovision as "Boogaloo"). It is one song,
    // kept as Melodifestivalen had it: the version a Swedish audience knows.
    const winner = y.melodifestivalen.find((r) => r.place === 1);
    if (y.sweden) {
      const at = `Sweden at Eurovision ${ordinal(y.sweden.place)}`;
      if (winner) {
        songs.delete(`${key(y.sweden.title)}|${y.year}`); // already added as a Eurovision top 3
        add(winner.title, winner.artist, y.year, at);
        const won = y.eurovision.find((r) => key(r.title) === key(y.sweden!.title));
        if (won) add(winner.title, winner.artist, y.year, `Eurovision ${ordinal(won.place)}`);
        const song = songs.get(`${key(winner.title)}|${y.year}`)!;
        if (key(y.sweden.title) !== key(winner.title) && !song.aka.includes(y.sweden.title)) song.aka.push(y.sweden.title);
      } else add(y.sweden.title, y.sweden.artist, y.year, at);
    }
    for (const r of y.melodifestivalen) add(r.title, r.artist, y.year, `Melodifestivalen ${ordinal(r.place)}`);
  }
  return { songs: [...songs.values()], years };
}
