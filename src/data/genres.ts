/**
 * Genres and year spans for narrowing down the deck. Pure functions only.
 */
import type { Song } from '../game/engine';
import { msg, type Messages } from '../i18n';

export type Genre = 'pop' | 'rock' | 'hiphop' | 'dance' | 'soul' | 'swedish';

/** The labels are in the current language (src/i18n). */
export const GENRES: { id: Genre; readonly label: string }[] = (['pop', 'rock', 'hiphop', 'dance', 'soul', 'swedish'] as const).map((id) => ({
  id,
  get label() {
    return msg().genres[id];
  },
}));

export const genreLabel = (g: Genre) => GENRES.find((x) => x.id === g)?.label ?? g;

// Spotify tags artists with fine-grained genres ("album rock", "swedish
// eurodance"). These patterns fold them into the game's few categories.
const SPOTIFY_GENRE_PATTERNS: [Genre, RegExp][] = [
  ['hiphop', /hip ?hop|rap|trap|drill|grime|r&b|rnb|urban contemporary/],
  ['dance', /house|edm|electro|techno|trance|dance|eurodance|dubstep|drum and bass|big room|synth/],
  ['soul', /soul|funk|disco|motown|doo-wop|gospel|blues|jazz|swing|crooner/],
  ['rock', /rock|metal|punk|grunge|indie|alternative|emo|britpop|new wave|shoegaze|garage/],
  ['pop', /pop|schlager|boy band|girl group|singer-songwriter|easy listening|adult standards/],
  ['swedish', /swedish|svensk|sweden|dansband/],
];

/** Maps an artist's Spotify genres to the game's genres. */
export function genresFromSpotify(names: readonly string[]): Genre[] {
  const out = new Set<Genre>();
  for (const name of names) {
    const n = name.toLowerCase();
    for (const [genre, pattern] of SPOTIFY_GENRE_PATTERNS) if (pattern.test(n)) out.add(genre);
  }
  return GENRES.map((g) => g.id).filter((g) => out.has(g));
}

export interface DeckFilter {
  /** Empty means every genre. */
  genres: Genre[];
  /** Inclusive; null means no limit. */
  fromYear: number | null;
  toYear: number | null;
}

export const NO_FILTER: DeckFilter = { genres: [], fromYear: null, toYear: null };

export function isFiltered(f: DeckFilter): boolean {
  return f.genres.length > 0 || f.fromYear !== null || f.toYear !== null;
}

/**
 * Keeps songs in the year span that have at least one of the chosen genres.
 * With genres chosen, songs whose genre is unknown are left out.
 */
export function filterSongs(songs: readonly Song[], f: DeckFilter): Song[] {
  return songs.filter(
    (s) =>
      (f.fromYear === null || s.year >= f.fromYear) &&
      (f.toYear === null || s.year <= f.toYear) &&
      (f.genres.length === 0 || (s.genres ?? []).some((g) => f.genres.includes(g))),
  );
}

export interface Preset {
  id: string;
  readonly label: string;
  readonly detail: string;
  filter: DeckFilter;
}

type StandardPreset = Exclude<keyof Messages['presets'], 'myEra' | 'myEraDetail' | 'myGenres' | 'and'>;

/** A preset whose texts follow the current language. */
const preset = (id: StandardPreset, filter: DeckFilter): Preset => ({
  id,
  filter,
  get label() {
    return msg().presets[id].label;
  },
  get detail() {
    return msg().presets[id].detail;
  },
});

export const STANDARD_PRESETS: Preset[] = [
  preset('all', NO_FILTER),
  preset('pre80', { genres: [], fromYear: null, toYear: 1979 }),
  preset('80s90s', { genres: [], fromYear: 1980, toYear: 1999 }),
  preset('modern', { genres: [], fromYear: 2000, toYear: null }),
  preset('rock', { genres: ['rock'], fromYear: null, toYear: null }),
  preset('party', { genres: ['pop', 'dance', 'soul'], fromYear: null, toYear: null }),
  preset('swedish', { genres: ['swedish'], fromYear: null, toYear: null }),
];

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))];
}

/**
 * Presets built from someone's own music: the years most of it comes from,
 * and the genres it leans towards. Needs a handful of songs to say anything.
 */
export function personalPresets(songs: readonly Song[]): Preset[] {
  if (songs.length < 10) return [];
  const presets: Preset[] = [];

  const years = songs.map((s) => s.year).sort((a, b) => a - b);
  const from = percentile(years, 0.1);
  const to = percentile(years, 0.9);
  if (to > from) {
    presets.push({
      id: 'my-era',
      label: msg().presets.myEra,
      detail: msg().presets.myEraDetail(from, to),
      filter: { genres: [], fromYear: from, toYear: to },
    });
  }

  const counts = new Map<Genre, number>();
  for (const s of songs) for (const g of s.genres ?? []) counts.set(g, (counts.get(g) ?? 0) + 1);
  const top = [...counts.entries()]
    .filter(([, n]) => n >= Math.max(3, songs.length * 0.15))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([g]) => g);
  if (top.length) {
    presets.push({
      id: 'my-genres',
      label: msg().presets.myGenres,
      detail: top.map(genreLabel).join(msg().presets.and),
      filter: { genres: top, fromYear: null, toYear: null },
    });
  }
  return presets;
}

export function sameFilter(a: DeckFilter, b: DeckFilter): boolean {
  return (
    a.fromYear === b.fromYear &&
    a.toYear === b.toYear &&
    a.genres.length === b.genres.length &&
    a.genres.every((g) => b.genres.includes(g))
  );
}

const FILTER_KEY = 'mq.filter';

export function loadFilter(): DeckFilter {
  try {
    const f = JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null');
    if (f && Array.isArray(f.genres)) {
      const known = new Set(GENRES.map((g) => g.id));
      return {
        genres: f.genres.filter((g: Genre) => known.has(g)),
        fromYear: typeof f.fromYear === 'number' ? f.fromYear : null,
        toYear: typeof f.toYear === 'number' ? f.toYear : null,
      };
    }
  } catch {
    /* ignore */
  }
  return NO_FILTER;
}

export function saveFilter(f: DeckFilter): void {
  localStorage.setItem(FILTER_KEY, JSON.stringify(f));
}
