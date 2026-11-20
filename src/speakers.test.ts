import { describe, expect, it } from 'vitest';
import { parseSpeakerChoice, sameSpeaker, speakerKey, SPOTIFY_APP } from './speakers';

const sonos = { kind: 'sonos' as const, code: 'ABCDEF', speaker: { id: 'RINCON_A', name: 'Kitchen' } };

describe('speaker choices', () => {
  it('reads saved choices, including Sonos ones saved before the Spotify app option', () => {
    expect(parseSpeakerChoice({ kind: 'spotify-app' })).toEqual(SPOTIFY_APP);
    expect(parseSpeakerChoice({ code: 'ABCDEF', speaker: { id: 'RINCON_A', name: 'Kitchen' } })).toEqual(sonos);
    expect(parseSpeakerChoice(sonos)).toEqual(sonos);
    expect(parseSpeakerChoice({ code: 'abc', speaker: {} })).toBeNull();
    expect(parseSpeakerChoice(null)).toBeNull();
    expect(parseSpeakerChoice('x')).toBeNull();
  });

  it('compares choices and keys them for making the player again', () => {
    expect(sameSpeaker(null, null)).toBe(true);
    expect(sameSpeaker(SPOTIFY_APP, { kind: 'spotify-app' })).toBe(true);
    expect(sameSpeaker(sonos, { ...sonos })).toBe(true);
    expect(sameSpeaker(sonos, { ...sonos, speaker: { id: 'RINCON_B', name: 'Bed' } })).toBe(false);
    expect(sameSpeaker(sonos, SPOTIFY_APP)).toBe(false);
    expect(sameSpeaker(null, SPOTIFY_APP)).toBe(false);
    expect(speakerKey(null)).toBe('');
    expect(speakerKey(sonos)).not.toBe(speakerKey(SPOTIFY_APP));
  });
});
