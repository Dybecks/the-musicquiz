import { describe, expect, it } from 'vitest';
import type { Song } from '../game/engine';
import {
  articleUrl,
  artistNames,
  cleanSongTitle,
  findFact,
  mainArtist,
  normalize,
  pickArtistPage,
  pickSongPage,
  shorten,
  type WikiPage,
} from './wikipedia';

const song = (title: string, artist: string, extra: Partial<Song> = {}): Song => ({
  id: `${title}-${artist}`,
  title,
  artist,
  year: 1975,
  ...extra,
});

const page = (title: string, extract: string, index = 1, extra: Partial<WikiPage> = {}): WikiPage => ({
  title,
  extract,
  index,
  ...extra,
});

describe('title and artist helpers', () => {
  it('normalizes loosely', () => {
    expect(normalize('The Beatles')).toBe('beatles');
    expect(normalize('Beyoncé')).toBe('beyonce');
    expect(normalize('Simon & Garfunkel')).toBe(normalize('Simon and Garfunkel'));
    expect(normalize("(I Can't Get No) Satisfaction")).toBe('i can t get no satisfaction');
  });

  it('drops Spotify-style suffixes from song titles', () => {
    expect(cleanSongTitle('Bohemian Rhapsody - Remastered 2011')).toBe('Bohemian Rhapsody');
    expect(cleanSongTitle('Old Town Road (feat. Billy Ray Cyrus)')).toBe('Old Town Road');
    expect(cleanSongTitle("(Sittin' On) The Dock of the Bay")).toBe("(Sittin' On) The Dock of the Bay");
  });

  it('takes the first credited artist', () => {
    expect(mainArtist('Marvin Gaye & Tammi Terrell')).toBe('Marvin Gaye');
    expect(mainArtist('Julie Andrews, Dick Van Dyke')).toBe('Julie Andrews');
  });

  it('matches the full credit before the first artist', () => {
    expect(artistNames('Earth, Wind & Fire')).toEqual(['earth wind and fire', 'earth']);
    expect(artistNames('Queen')).toEqual(['queen']);
  });

  it('builds article links', () => {
    expect(articleUrl('Hey Jude')).toBe('https://en.wikipedia.org/wiki/Hey_Jude');
  });
});

describe('pickSongPage', () => {
  it('takes the song article that names the artist', () => {
    const pages = [
      page('Respect (disambiguation)', 'Respect may refer to', 1, { pageprops: { disambiguation: '' } }),
      page('Respect', 'Respect, also called esteem, is a positive feeling.', 2),
      page('Respect (song)', '"Respect" is a song written by Otis Redding, made famous by Aretha Franklin.', 3),
    ];
    expect(pickSongPage(pages, song('Respect', 'Aretha Franklin'))?.title).toBe('Respect (song)');
  });

  it('matches the artist as whole words', () => {
    const pages = [page('Hello', '"Hello" is a song by Adeleine Smith.')];
    expect(pickSongPage(pages, song('Hello', 'Adele'))).toBeNull();
  });

  it('rejects an article with the right title that is about another song', () => {
    const pages = [page('Hello (Lionel Richie song)', '"Hello" is a song by Lionel Richie.')];
    expect(pickSongPage(pages, song('Hello', 'Adele'))).toBeNull();
  });

  it('accepts soundtrack songs named after their film instead of the performer', () => {
    const pages = [page('Over the Rainbow', '"Over the Rainbow" is a ballad from the film The Wizard of Oz.')];
    expect(pickSongPage(pages, song('Over the Rainbow', 'Someone Else', { from: 'The Wizard of Oz' }))?.title).toBe(
      'Over the Rainbow',
    );
  });

  it('prefers the higher-ranked match', () => {
    const pages = [
      page('Yesterday (Beatles song)', '"Yesterday" is a song by the Beatles.', 2),
      page('Yesterday', '"Yesterday" is a song by the Beatles, the best.', 1),
    ];
    expect(pickSongPage(pages, song('Yesterday', 'The Beatles'))?.title).toBe('Yesterday');
  });
});

describe('pickArtistPage', () => {
  it('prefers the full band name over the first word of it', () => {
    const pages = [
      page('Earth (band)', 'Earth is an American drone band.', 1),
      page('Earth, Wind & Fire', 'Earth, Wind & Fire is an American band formed in Chicago.', 2),
    ];
    expect(pickArtistPage(pages, 'Earth, Wind & Fire')?.title).toBe('Earth, Wind & Fire');
  });

  it('takes the musician, not a namesake', () => {
    const pages = [
      page('Prince', 'A prince is a male ruler or member of a monarch’s family.', 1),
      page('Prince (musician)', 'Prince Rogers Nelson was an American singer, songwriter and musician.', 2),
    ];
    expect(pickArtistPage(pages, 'Prince')?.title).toBe('Prince (musician)');
  });

  it('skips song and album articles named like the artist', () => {
    const pages = [
      page('Queen (album)', 'Queen is the debut album by the British rock band Queen.', 1),
      page('Queen (band)', 'Queen are a British rock band formed in London in 1970.', 2),
    ];
    expect(pickArtistPage(pages, 'Queen')?.title).toBe('Queen (band)');
  });
});

describe('shorten', () => {
  it('removes empty brackets left by pronunciation guides', () => {
    expect(shorten('Beyoncé Knowles ( ; born 1981) is a singer.')).toBe('Beyoncé Knowles (born 1981) is a singer.');
  });

  it('keeps whole sentences within the limit', () => {
    const text = 'First sentence here. Second one is a bit longer. Third would be too much.';
    expect(shorten(text, 50)).toBe('First sentence here. Second one is a bit longer.');
  });

  it('keeps only the first paragraph', () => {
    expect(shorten('One paragraph.\nAnother paragraph.')).toBe('One paragraph.');
  });

  it('cuts a single overlong sentence at a word', () => {
    const out = shorten('word '.repeat(200), 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('findFact', () => {
  const fetcher = (responses: WikiPage[][]) => {
    const urls: string[] = [];
    const f = async (url: string) => {
      urls.push(url);
      const pages = responses.shift() ?? [];
      return { ok: true, json: async () => ({ query: { pages } }) };
    };
    return { f, urls };
  };

  it('uses the song article when there is one', async () => {
    const { f, urls } = fetcher([[page('Hey Jude', '"Hey Jude" is a song by the Beatles.')]]);
    const fact = await findFact(song('Hey Jude', 'The Beatles'), f);
    expect(fact).toMatchObject({ about: 'song', title: 'Hey Jude', url: 'https://en.wikipedia.org/wiki/Hey_Jude' });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('origin=*');
  });

  it('falls back to the artist', async () => {
    const { f, urls } = fetcher([[], [page('Queen (band)', 'Queen are a British rock band formed in London in 1970.')]]);
    const fact = await findFact(song('Some Deep Cut', 'Queen'), f);
    expect(fact?.about).toBe('artist');
    expect(urls).toHaveLength(2);
  });

  it('does not fall back to the artist for soundtrack songs', async () => {
    const { f, urls } = fetcher([[]]);
    expect(await findFact(song('Duel of the Fates', 'John Williams', { from: 'Star Wars' }), f)).toBeNull();
    expect(urls).toHaveLength(1);
  });

  it('returns null when nothing matches', async () => {
    const { f } = fetcher([[], []]);
    expect(await findFact(song('Unknown', 'Nobody'), f)).toBeNull();
  });
});
