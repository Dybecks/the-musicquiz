import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sonos from '../sonos.js';
import { fakeSonos } from './fake-sonos.js';

const TRACK = 'spotify:track:4uLU6hMCjMI75M1A2tKUQC';

test('lists groups by coordinator, leaving out hidden members', async () => {
  const s = await fakeSonos();
  try {
    const groups = await sonos.groups(s.host);
    assert.deepEqual(
      groups.map(({ id, name }) => ({ id, name })),
      [
        { id: 'RINCON_D', name: 'Bedroom' },
        { id: 'RINCON_A', name: 'Kitchen + Living Room' },
      ],
    );
    assert.equal(groups[1].host, s.host);
  } finally {
    await s.close();
  }
});

test('builds the Sonos URI and metadata for a Spotify track, titled Mystery song', () => {
  const { uri, metadata } = sonos.spotifyTrack(TRACK, 2311);
  assert.equal(uri, 'spotify%3atrack%3a4uLU6hMCjMI75M1A2tKUQC');
  assert.match(metadata, /<res protocolInfo="x-rincon-playlist:\*:\*:\*">spotify%3atrack%3a4uLU6hMCjMI75M1A2tKUQC<\/res>/);
  assert.match(metadata, /<item id="00032020spotify%3atrack%3a4uLU6hMCjMI75M1A2tKUQC"/);
  assert.match(metadata, /SA_RINCON2311_X_#Svc2311-0-Token/);
  assert.match(metadata, /<dc:title>Mystery song<\/dc:title>/);
  assert.throws(() => sonos.spotifyTrack('spotify:album:xyz', 2311));
});

test('plays a track: clears the queue, adds it, points the group at the queue and plays', async () => {
  const s = await fakeSonos();
  try {
    const [group] = (await sonos.groups(s.host)).filter((g) => g.id === 'RINCON_A');
    await sonos.playSpotify(group, TRACK);
    const avt = s.calls.filter((c) => c.path === '/MediaRenderer/AVTransport/Control').map((c) => c.action);
    assert.deepEqual(avt, ['RemoveAllTracksFromQueue', 'AddURIToQueue', 'SetAVTransportURI', 'Seek', 'Play']);
    assert.equal(s.calls.find((c) => c.action === 'SetAVTransportURI').args.CurrentURI, 'x-rincon-queue:RINCON_A#0');
    assert.equal(await sonos.transportState(group), 'PLAYING');
    await sonos.pause(group);
    assert.equal(await sonos.transportState(group), 'PAUSED_PLAYBACK');
    await sonos.pause(group); // already paused: no error
    await sonos.resume(group);
    assert.equal(s.state, 'PLAYING');
  } finally {
    await s.close();
  }
});

test('falls back to the other Spotify region, and says so when both fail', async () => {
  const s = await fakeSonos({ rejectRegions: [2311] });
  try {
    const group = (await sonos.groups(s.host))[0];
    await sonos.playSpotify(group, TRACK);
    const regions = s.calls.filter((c) => c.action === 'AddURIToQueue').map((c) => /SA_RINCON(\d+)/.exec(c.args.EnqueuedURIMetaData.replace(/&lt;/g, '<'))[1]);
    assert.deepEqual(regions, ['2311', '3079']);
  } finally {
    await s.close();
  }
  const bad = await fakeSonos({ rejectRegions: [2311, 3079] });
  try {
    const group = (await sonos.groups(bad.host))[0];
    await assert.rejects(sonos.playSpotify(group, TRACK), /Spotify is added in the Sonos app/);
  } finally {
    await bad.close();
  }
});

test('rejects a bad track before touching the queue', async () => {
  const s = await fakeSonos();
  try {
    const group = (await sonos.groups(s.host))[0];
    await assert.rejects(sonos.playSpotify(group, undefined), /Not a Spotify track/);
    await assert.rejects(sonos.playSpotify(group, 'http://example.com/x.mp3'), /Not a Spotify track/);
    assert.equal(s.calls.filter((c) => c.path === '/MediaRenderer/AVTransport/Control').length, 0);
  } finally {
    await s.close();
  }
});

test('discovery returns quickly, even with a short timeout', async () => {
  const found = await sonos.discover(300);
  assert.ok(Array.isArray(found));
});

test('reports an unreachable speaker readably', async () => {
  await assert.rejects(sonos.groups('127.0.0.1:1'), /Can't reach the speaker/);
});
