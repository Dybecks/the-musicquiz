import { describe, expect, it, vi } from 'vitest';
import type { Song } from '../game/engine';
import { findArtwork, loadArtwork, oembedUrl, pageYear, pickWorkPage, spotifyIdOf, workSearchUrl, type WorkPage } from './artwork';

const page = (title: string, description: string, index = 1, extra: Partial<WorkPage> = {}): WorkPage => ({
  title,
  description,
  index,
  thumbnail: { source: `https://img/${encodeURIComponent(title)}` },
  ...extra,
});

const song = (extra: Partial<Song> = {}): Song => ({ id: 'sp:abc123', title: 'Dance the Night', artist: 'Dua Lipa', year: 2023, ...extra });

describe('pickWorkPage', () => {
  it('picks the film, not the toy that shares its name', () => {
    const pages = [page('Barbie', 'Fashion doll franchise', 1), page('Barbie (film)', '2023 film by Greta Gerwig', 2)];
    expect(pickWorkPage(pages, { from: 'Barbie', year: 2023 })?.title).toBe('Barbie (film)');
  });

  it('skips a remake or adaptation from another year', () => {
    const pages = [
      page('Knight Rider (2008 TV series)', '2008 TV series', 1),
      page('The Little Mermaid (musical)', '2007 musical based on the 1989 film of the same name', 2),
    ];
    expect(pickWorkPage(pages, { from: 'Knight Rider', year: 1982 })).toBeNull();
    expect(pickWorkPage(pages, { from: 'The Little Mermaid', year: 1989 })).toBeNull();
    const withFilm = [...pages, page('The Little Mermaid (1989 film)', 'American animated film', 5)];
    expect(pickWorkPage(withFilm, { from: 'The Little Mermaid', year: 1989 })?.title).toBe('The Little Mermaid (1989 film)');
  });

  it('prefers the page that names the year, and allows a couple of years either way', () => {
    const pages = [page('Doom (franchise)', 'Video game franchise', 1), page('Doom (2016 video game)', 'First-person shooter game', 2)];
    expect(pickWorkPage(pages, { from: 'Doom', year: 2016 })?.title).toBe('Doom (2016 video game)');
    expect(pickWorkPage([page('Evita (musical)', '1978 musical by Lloyd Webber and Rice')], { from: 'Evita', year: 1976 })).not.toBeNull();
  });

  it('accepts a subtitle and a numbered sequel, but not things about the work', () => {
    expect(
      pickWorkPage([page('Sweeney Todd: The Demon Barber of Fleet Street', '1979 musical by Stephen Sondheim')], { from: 'Sweeney Todd', year: 1979 }),
    ).not.toBeNull();
    expect(pickWorkPage([page('Frozen 2', '2019 animated Disney film')], { from: 'Frozen II', year: 2019 })).not.toBeNull();
    expect(pickWorkPage([page('Minecraft: The Story of Mojang', '2012 documentary film')], { from: 'Minecraft', year: 2011 })).toBeNull();
  });

  it('needs an image and a real article', () => {
    expect(pickWorkPage([page('Friends', 'American television sitcom (1994–2004)', 1, { thumbnail: undefined })], { from: 'Friends', year: 1994 })).toBeNull();
    expect(pickWorkPage([page('Cats', 'Musical', 1, { pageprops: { disambiguation: '' } })], { from: 'Cats', year: 1981 })).toBeNull();
  });
});

describe('helpers', () => {
  it('reads the year from the title first, then the description', () => {
    expect(pageYear(page('Doom (2016 video game)', 'First-person shooter game'))).toBe(2016);
    expect(pageYear(page('The Little Mermaid (musical)', '2007 musical based on the 1989 film'))).toBe(2007);
    expect(pageYear(page('Cheers', 'American television sitcom'))).toBeNull();
  });

  it('finds the Spotify id', () => {
    expect(spotifyIdOf({ id: 'x', spotifyId: 'abc' })).toBe('abc');
    expect(spotifyIdOf({ id: 'sp:def' })).toBe('def');
    expect(spotifyIdOf({ id: 'local-1' })).toBeNull();
  });

  it('builds the request URLs', () => {
    expect(workSearchUrl({ from: 'Barbie', year: 2023 })).toContain('pilicense=any');
    expect(oembedUrl('abc')).toBe('https://open.spotify.com/oembed?url=https%3A%2F%2Fopen.spotify.com%2Ftrack%2Fabc');
  });
});

const json = (body: unknown) => ({ ok: true, json: async () => body });

describe('findArtwork', () => {
  it('uses the album cover for an ordinary song', async () => {
    const fetcher = vi.fn(async () => json({ thumbnail_url: 'https://cover' }));
    expect(await findArtwork(song(), fetcher)).toEqual({ url: 'https://cover', kind: 'album' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses the work for a soundtrack song', async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.includes('wikipedia') ? json({ query: { pages: [page('Barbie (film)', '2023 film by Greta Gerwig')] } }) : json({}),
    );
    const art = await findArtwork(song({ from: 'Barbie' }), fetcher);
    expect(art?.kind).toBe('work');
    expect(art?.url).toContain('Barbie');
  });

  it('falls back to the album cover when the work has no picture or Wikipedia fails', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('wikipedia')) throw new Error('offline');
      return json({ thumbnail_url: 'https://cover' });
    });
    expect(await findArtwork(song({ from: 'Friends' }), fetcher)).toEqual({ url: 'https://cover', kind: 'album' });
  });

  it('is null when nothing is found', async () => {
    expect(await findArtwork(song({ id: 'local', spotifyId: undefined }), vi.fn())).toBeNull();
  });
});

describe('loadArtwork', () => {
  it('looks a song up once, and treats a failure as no picture', async () => {
    const lookup = vi.fn(async () => {
      throw new Error('offline');
    });
    const s = song({ id: 'sp:once' });
    expect(await loadArtwork(s, lookup)).toBeNull();
    expect(await loadArtwork(s, lookup)).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
