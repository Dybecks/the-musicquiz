# Sonos bridge

A small program that lets The Music Quiz play its mystery songs on Sonos speakers.
Run it on a computer (a Mac, PC or Raspberry Pi) on the same Wi-Fi as the speakers,
and keep it running while you play.

## What you need

- Node.js 20 or newer (<https://nodejs.org>, or `brew install node` on a Mac).
- Spotify added as a service in the Sonos app (Settings → Services & Voice).
  The speaker plays the songs with that Spotify account.

## Start it

```bash
git clone https://github.com/Dybecks/the-musicquiz.git
cd the-musicquiz/bridge
npm install
npm start
```

It lists the speakers it found and a six-letter **speaker code**:

```
Ready. In the game, tap 🔊 and enter the speaker code:  KQWMTR
Found: Kitchen, Living Room + Bedroom
```

The code is saved in `~/.the-musicquiz-bridge.json`, so it stays the same next time.

On a Mac:
- The first start asks whether the Terminal may find devices on the local network.
  Allow it, otherwise no speakers are found.
- To keep the Mac from sleeping during the game, start the bridge with
  `caffeinate -i npm start`.

## In the game

On the host device (phone, tablet or laptop) during a game:

1. Tap **🔊 This device** at the bottom.
2. Enter the speaker code and tap **Find Sonos speakers**.
3. Pick a speaker or group.

The songs now play on that speaker, and the game remembers the choice. Tap
**🔊 *speaker name*** to switch back to **This device**.

## Good to know

- The bridge replaces what is in the speaker's queue in the Sonos app with the
  mystery song. The Sonos app may show the song's title, so only someone who isn't
  guessing should open it.
- Each group is controlled through its coordinator, so the game plays on the whole
  group as the Sonos app shows it.
- Anyone who has the speaker code can play songs on your speakers while the
  bridge runs. To get a new code, delete `~/.the-musicquiz-bridge.json`, or start the
  bridge with `npm start -- --code ABCDEF`.

## When it doesn't work

| What happens | Try |
| --- | --- |
| "No Sonos speakers found" | The computer must be on the same Wi-Fi as the speakers. On a Mac, allow Local Network access for Terminal (System Settings → Privacy & Security → Local Network). Or name a speaker directly: `npm start -- --speaker 192.168.1.20` (the IP is in the Sonos app under Settings → System → About My System). |
| "No Sonos bridge answers to that code" | Check that the bridge is running and the code matches. The bridge and the game must both reach the internet, because the PeerJS server introduces them to each other. |
| "…wouldn't take the Spotify song" | Add Spotify in the Sonos app. The bridge tries Sonos's European Spotify service first, then the US one. |
| A song is found but doesn't play | The song may not be available on Spotify in your country. Skip it. |

## How it works

- **Talking to the game:** the bridge connects to the game over WebRTC
  ([PeerJS](https://peerjs.com/), with [node-datachannel](https://github.com/murat-dogan/node-datachannel)
  for WebRTC in Node). The game connects to the peer id
  `the-musicquiz-speaker-<code>`, the same way the phones join a game.
- **Talking to the speakers:** it uses the speakers' own network control (UPnP, port 1400):
  - it finds them with SSDP and reads the groups with `GetZoneGroupState`;
  - to play a song, it adds the `x-sonos-spotify:` URI to the group's queue and plays
    the queue. The track's title in the metadata it sends is "Mystery song".

The game can't do this from the browser itself: a web page can't reach devices on the
home network.

- `index.js`: speaker code, connection and requests from the game.
- `sonos.js`: finding the speakers and controlling them.
- `test/`: tests against a pretend speaker (`npm test`, no install needed).

To use your own PeerJS server, set `MQ_PEER_HOST` (and optionally `MQ_PEER_PORT`,
`MQ_PEER_PATH`, `MQ_PEER_SECURE=false`), matching the game's `VITE_PEER_*` settings.
