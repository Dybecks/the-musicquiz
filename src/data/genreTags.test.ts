import { describe, expect, it } from 'vitest';
import { genresFromTags, mergeGenres, tagGenres } from './genreTags';
import { SEARCH_GENRE_DEFS } from './searchGenres';

const ORDER = SEARCH_GENRE_DEFS.map((g) => g.id);

describe('tagGenres', () => {
  it('maps tags to catalogue genres', () => {
    expect(tagGenres('Punk Rock')).toEqual(['rock', 'punk']);
    expect(tagGenres('hip hop')).toEqual(['hiphop']);
    expect(tagGenres('contemporary r&b')).toEqual(['rnb']);
    expect(tagGenres('heavy metal')).toEqual(['metal']);
    expect(tagGenres('swedish')).toEqual(['swedishpop']);
    expect(tagGenres('seen live')).toEqual([]);
    expect(tagGenres('80s')).toEqual([]);
  });
});

describe('genresFromTags', () => {
  it('keeps the strong genres, at most three', () => {
    expect(genresFromTags([['rock', 10], ['hard rock', 5], ['pop', 2], ['blues', 9]])).toEqual(['rock']);
    expect(genresFromTags([['disco', 5], ['pop', 4], ['soul', 2], ['funk', 1]])).toEqual(['disco', 'pop', 'soul']);
  });
  it('counts each source the same', () => {
    expect(genresFromTags([['pop', 100]], [['dance', 3]])).toEqual(['pop', 'dance']);
  });
  it('is empty without known tags', () => expect(genresFromTags([['seen live', 100]], [])).toEqual([]));
});

describe('mergeGenres', () => {
  it('uses the tags, keeping the hand-set Swedish genres', () => {
    expect(mergeGenres(['pop', 'swedishpop'], ['dance', 'pop'], ORDER)).toEqual(['pop', 'dance', 'swedishpop']);
  });
  it('keeps the hand-set genres when the tags have nothing', () => {
    expect(mergeGenres(['rock'], [], ORDER)).toEqual(['rock']);
  });
});
