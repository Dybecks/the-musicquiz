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
    expect(tagGenres('chicago blues')).toEqual(['rnb']);
  });
});

describe('genresFromTags', () => {
  it('keeps the strong genres, at most two', () => {
    expect(genresFromTags([['rock', 10], ['hard rock', 5], ['pop', 2], ['folk', 9]])).toEqual(['rock']);
    expect(genresFromTags([['disco', 5], ['pop', 4], ['soul', 2], ['funk', 1]])).toEqual(['disco', 'pop']);
    expect(genresFromTags([['heavy metal', 6], ['thrash metal', 4], ['hard rock', 3], ['pop', 2]])).toEqual(['metal']);
  });
  it('counts blues as R&B (Hound Dog)', () => {
    expect(genresFromTags([['blues', 3], ['chicago blues', 1], ['electric blues', 1], ['rock', 1]])).toEqual(['rnb']);
  });
  it('counts each source the same', () => {
    expect(genresFromTags([['pop', 100]], [['dance', 3]])).toEqual(['pop', 'dance']);
  });
  it('ignores a genre with a single vote', () => {
    expect(genresFromTags([['rock', 3], ['dance', 1]])).toEqual(['rock']);
    expect(genresFromTags([['dance', 1]])).toEqual([]);
  });
  it('is empty without known tags', () => expect(genresFromTags([['seen live', 100]], [])).toEqual([]));
});

describe('mergeGenres', () => {
  it('adds the tags to the hand-set genres, never removing one', () => {
    expect(mergeGenres(['pop', 'swedishpop'], ['dance', 'pop'], ORDER)).toEqual(['pop', 'dance', 'swedishpop']);
    expect(mergeGenres(['rock'], ['dance'], ORDER)).toEqual(['rock', 'dance']);
  });
  it('keeps the hand-set genres when the tags have nothing', () => {
    expect(mergeGenres(['rock'], [], ORDER)).toEqual(['rock']);
  });
});
