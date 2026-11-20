import { useEffect, useRef, useState } from 'react';
import { NO_LOGIN_SONGS } from '../data/songs';
import { getDevices } from '../spotify/api';
import { ACTIVE_SPEAKER, createPremiumPlayback, createSpeakerPlayback, type Playback, type Speaker } from '../spotify/playback';

/** How long the test sound plays. */
const TEST_MS = 6000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * "Play the music on": this browser, the device Spotify is playing on now, or
 * a Spotify Connect speaker. Finding speakers costs one request, and only
 * when the host taps. "Test sound" plays a few seconds on the choice.
 *
 * `testable` is false in the game, where the next song is the test.
 */
export function SpeakerPicker(props: { speaker: Speaker | null; onChange: (s: Speaker | null) => void; testable?: boolean }) {
  const { speaker, onChange } = props;
  const [speakers, setSpeakers] = useState<Speaker[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [testing, setTesting] = useState<'idle' | 'playing' | 'ok'>('idle');
  const test = useRef<{ playback: Playback; timer: number } | null>(null);

  const stopTest = () => {
    const t = test.current;
    test.current = null;
    if (!t) return;
    clearTimeout(t.timer);
    void t.playback.stop().finally(() => t.playback.destroy());
  };
  useEffect(() => stopTest, []);

  const choose = (s: Speaker | null) => {
    stopTest();
    setTesting('idle');
    setNote(null);
    onChange(s);
  };

  const find = async () => {
    setBusy(true);
    setNote(null);
    try {
      const found = (await getDevices()).map((d) => ({ id: d.id, name: d.name }));
      setSpeakers(found);
      if (found.length === 0) setNote('Spotify listed no speakers. Pick “Where Spotify plays now” instead, or start a song on the speaker from the Spotify app and look again.');
    } catch (e) {
      setNote(message(e));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    stopTest();
    setNote(null);
    setTesting('playing');
    let playback: Playback | null = null;
    try {
      playback = speaker ? createSpeakerPlayback(speaker) : await createPremiumPlayback();
      const song = NO_LOGIN_SONGS[Math.floor(Math.random() * NO_LOGIN_SONGS.length)];
      await playback.prepare(song);
      await playback.play();
      const timer = window.setTimeout(() => {
        stopTest();
        setTesting('ok');
      }, TEST_MS);
      test.current = { playback, timer };
    } catch (e) {
      playback?.destroy();
      setTesting('idle');
      setNote(message(e));
    }
  };

  const choices: Speaker[] = [ACTIVE_SPEAKER, ...(speaker?.id && !speakers?.some((d) => d.id === speaker.id) ? [speaker] : []), ...(speakers ?? [])];

  return (
    <div className="speakers">
      <h2>Play the music on</h2>
      <div className="chips" role="radiogroup" aria-label="Play the music on">
        <button role="radio" aria-checked={!speaker} className={`chip ${!speaker ? 'selected' : ''}`} onClick={() => choose(null)}>
          This browser
        </button>
        {choices.map((d) => (
          <button key={d.id || 'active'} role="radio" aria-checked={speaker?.id === d.id} className={`chip ${speaker?.id === d.id ? 'selected' : ''}`} onClick={() => choose(d)}>
            {d.name}
          </button>
        ))}
        <button className="chip" onClick={find} disabled={busy}>
          {busy ? 'Looking…' : speakers ? '↻ Look again' : '+ Find speakers (Sonos…)'}
        </button>
      </div>
      {props.testable !== false && (
        <div className="test-sound">
          <button className="ghost" onClick={testing === 'playing' ? () => (stopTest(), setTesting('idle')) : runTest}>
            {testing === 'playing' ? '■ Stop test' : '🔊 Test sound'}
          </button>
          <span className="hint">
            {testing === 'playing' ? 'Playing a few seconds…' : testing === 'ok' ? 'Did you hear it? Then you’re set.' : 'Plays a few seconds of a song.'}
          </span>
        </div>
      )}
      {note && <p className="warn">{note}</p>}
      <p className="hint">
        Spotify only lists a speaker (like a Sonos) for a while after it played Spotify. Not there? Pick “Where Spotify plays now” and start any song on the speaker
        from the Spotify app, and the game takes over from there.
      </p>
    </div>
  );
}
