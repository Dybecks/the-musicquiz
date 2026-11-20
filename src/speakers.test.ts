import { describe, expect, it } from 'vitest';
import { parseSpeakerChoice, sameSpeaker, speakerKey, speakerLabel, SPOTIFY_APP } from './speakers';

const sonos = { kind: 'sonos' as const, code: 'ABCDEF', speaker: { id: 'RINCON_A', name: 'Kitchen' } };
const speaker = { kind: 'spotify-device' as const, device: { id: 'dev1', name: 'Living room', type: 'Speaker' } };

describe('speaker choices', () => {
  it('reads saved choices, including Sonos ones saved before the Spotify app option', () => {
    expect(parseSpeakerChoice({ kind: 'spotify-app' })).toEqual(SPOTIFY_APP);
    expect(parseSpeakerChoice({ code: 'ABCDEF', speaker: { id: 'RINCON_A', name: 'Kitchen' } })).toEqual(sonos);
    expect(parseSpeakerChoice(sonos)).toEqual(sonos);
    expect(parseSpeakerChoice({ code: 'abc', speaker: {} })).toBeNull();
    expect(parseSpeakerChoice(null)).toBeNull();
    expect(parseSpeakerChoice('x')).toBeNull();
  });

  it('reads a saved Spotify Connect device', () => {
    expect(parseSpeakerChoice(speaker)).toEqual(speaker);
    expect(parseSpeakerChoice({ kind: 'spotify-device', device: { id: 'dev1', name: 'Living room' } })).toEqual({
      kind: 'spotify-device',
      device: { id: 'dev1', name: 'Living room', type: '' },
    });
    expect(parseSpeakerChoice({ kind: 'spotify-device', device: { id: '', name: 'X' } })).toBeNull();
    expect(parseSpeakerChoice({ kind: 'spotify-device' })).toBeNull();
  });

  it('compares choices and keys them for making the player again', () => {
    expect(sameSpeaker(null, null)).toBe(true);
    expect(sameSpeaker(SPOTIFY_APP, { kind: 'spotify-app' })).toBe(true);
    expect(sameSpeaker(sonos, { ...sonos })).toBe(true);
    expect(sameSpeaker(sonos, { ...sonos, speaker: { id: 'RINCON_B', name: 'Bed' } })).toBe(false);
    expect(sameSpeaker(sonos, SPOTIFY_APP)).toBe(false);
    expect(sameSpeaker(null, SPOTIFY_APP)).toBe(false);
    expect(sameSpeaker(speaker, { ...speaker, device: { ...speaker.device } })).toBe(true);
    expect(sameSpeaker(speaker, { ...speaker, device: { ...speaker.device, id: 'dev2' } })).toBe(false);
    expect(sameSpeaker(speaker, SPOTIFY_APP)).toBe(false);
    expect(speakerKey(null)).toBe('');
    expect(speakerKey(sonos)).not.toBe(speakerKey(SPOTIFY_APP));
    expect(speakerLabel(speaker)).toBe('Living room');
    expect(speakerLabel(null)).toBe('This device');
  });
});
