import { uriFor, type Playback } from '../spotify/playback';
import { connectBridge, type SonosChoice } from './bridge';

/**
 * Plays each song on a Sonos speaker through the bridge. Nothing plays on
 * this device. The song is found the same way as for the other players: a
 * known Spotify id, or a search (which needs the Spotify login).
 */
export function createSonosPlayback(choice: SonosChoice): Playback {
  const bridge = connectBridge(choice.code);
  const speakerId = choice.speaker.id;
  let uri: string | null = null;
  let started = false;
  let listener: (playing: boolean) => void = () => {};
  bridge.onState((id, playing) => {
    if (id === speakerId && started) listener(playing);
  });

  return {
    kind: 'sonos',
    async prepare(song) {
      if (started) await bridge.pause(speakerId).catch(() => {});
      started = false;
      uri = await uriFor(song);
    },
    async play() {
      if (!uri) return;
      if (!started) {
        await bridge.play(speakerId, uri);
        started = true;
        listener(true);
      } else await bridge.resume(speakerId);
    },
    async pause() {
      await bridge.pause(speakerId);
    },
    async stop() {
      if (started) await bridge.pause(speakerId).catch(() => {});
      started = false;
      uri = null;
    },
    onStateChange(cb) {
      listener = cb;
    },
    destroy() {
      if (started) void bridge.pause(speakerId).catch(() => {});
      // Let the pause go out before the connection closes.
      setTimeout(() => bridge.close(), started ? 1000 : 0);
    },
  };
}
