# The Music Quiz

A party game about music history. A mystery song plays, and the player or team
whose turn it is places it on their timeline: before, after or between the
years they already have. Get it right and the card joins the timeline, so every
correct answer leaves smaller gaps and the next guess gets harder. The first to
collect the target number of cards (10 by default) wins.

It runs in the browser on a phone, tablet or laptop that everyone gathers around.

## How a game goes

1. Add the players or teams and choose how many cards are needed to win.
2. Everyone gets one random face-up starting card (title, artist, year).
3. On your turn, press **Play song** and listen. The title stays hidden.
4. Tap the gap on your timeline where you think the song belongs and **Lock in guess**.
5. The song is revealed. A correct placement adds the card to your timeline; a
   wrong one discards it and shows where it really belonged. Songs from the same
   year as a neighbouring card count as correct on either side.
6. Play passes to the next player. If the deck runs out, whoever has the most cards wins.

Use **Skip song** if a track can't be found or played; it draws a new song
without using up the turn. The game is saved in the browser, so a reload doesn't lose it.

## Playing together on phones

The host's device plays the music, and everyone else can follow along on their own phone or computer:

1. Invite people before the game starts, on the **Players & play** screen, or at any time
   during a game: tap **Share a game code**. A four-letter code appears (and
   **Share link** sends a `?join=CODE` link). The room stays open from game to game
   until **Stop sharing**.
2. On a phone, open the game, tap **Join a game on this phone**, type the code and a name,
   or just open the link. Everyone gets a random emoji as a profile picture (tap it for
   another one), shown next to their name, also on their votes.
3. Pick a team. Before the start the teams are the names typed in setup, so a renamed or
   added team shows up on the phones right away. The host picks a team too (or
   **Just running the game**) in the same panel.
4. When it's your team's turn, tap the spot on the timeline where you think the song
   belongs. Everyone sees the team's votes as emoji-and-name tags on the spots.
5. Each team member, the host included, taps **Lock in my vote**. When everyone on the
   team who is connected has locked in, the spot with the most votes is the guess. If the
   votes are split evenly, the team agrees on one spot and locks in again. Changing a vote
   unlocks it.

Everything that happens is sent to every device as it happens: votes, lock-ins, team
changes, the reveal, whether the song is playing, and the spot the host has tapped when
deciding for a team they aren't on. Phones never receive the song that is playing, only the
timelines, votes and the reveal. The host can still tap a spot and lock in for a team, for
example when someone's phone stops responding, and a team with nobody on a phone plays on the
host's screen as before. Phones reconnect by themselves after a reload or a dropped
connection, and so does the room after the host's page reloads.

### Adding your own songs from a phone (optional)

Joining needs no Spotify login. Anyone who wants to can tap **Add songs from my Spotify**
on their phone, log in to Spotify there, tick some of their playlists and send about 40
songs at a time (**Send more songs** fetches more). Songs sent before the start join the
deck when the game starts; songs sent during a game go straight into the deck. While the
game's Spotify app is in development mode, their account must be listed under **User
Management** in the Spotify dashboard, like any other login.

The phones talk to the host directly over WebRTC ([PeerJS](https://peerjs.com/)); the
free public PeerJS server only puts them in touch, so the game still needs no backend.
Some networks (strict mobile carrier or company NATs) block direct connections; being on
the same Wi-Fi works best. To use your own PeerJS server, set `VITE_PEER_HOST`
(and optionally `VITE_PEER_PORT`, `VITE_PEER_PATH`, `VITE_PEER_SECURE=false`).

The code: `src/multiplayer/protocol.ts` (messages, votes and what phones see, tested in
`protocol.test.ts`), `src/multiplayer/connection.ts` (the connections),
`src/multiplayer/useHostRoom.ts` (the host side), `src/components/SharePanel.tsx` (inviting),
`src/components/Remote.tsx` (the phone) and `src/components/AddMyMusic.tsx` (songs from a phone).

## Song decks

Under **Which songs?** the host ticks one or more decks; songs from several decks are
shuffled together, and a song that appears in two decks is only used once.

| Deck | Songs | Range |
| --- | --- | --- |
| Classic hits | 160 | Well-known songs from the 1950s to today |
| Movie songs | 50 | The Wizard of Oz (1939) to Barbie (2023) |
| Musicals | 50 | Oklahoma! (1943) to Beetlejuice (2019) |
| TV themes | 50 | Peter Gunn (1958) to Severance (2022) |
| Video game music | 50 | Super Mario Bros. (1985) to Baldur's Gate 3 (2023) |

The four soundtrack decks are in `src/data/soundtracks.ts`. They only hold songs written
for the film, show, game or musical, so the year on the card is the year that work first
came out: the film's release, the show's premiere, the game's first release, or the
musical's first major production (or concept album, as for Evita). Cards say where the
song is from. Their Spotify ids are looked up ahead of time (see **Spotify data shipped
with the game** below); a song without one is found with the Spotify search at play time,
which needs a login. Some video game music, Nintendo's in particular, isn't on Spotify;
such songs are listed for review instead of being matched to a cover.

## Spotify data shipped with the game

`scripts/spotify-precompute.ts` looks things up on Spotify once, so games don't have to:

- a Spotify track id for every ready-made song that has none pinned by hand
  (`src/data/spotify/track-ids.json`), so every song plays in the hidden player without
  a login or a request;
- the genre lists for **By genre** (`src/data/spotify/genre-pools.json`): for each genre
  and decade, the best-known songs from Spotify's genre search. Songs on compilations,
  remasters, live albums, karaoke and the like are skipped, so each song is dated by its
  own album; a song found in several decades keeps the earliest, and a song that is also
  in a ready-made deck keeps that deck's checked year.

Songs it can't match are listed in `src/data/spotify/REVIEW.md`, never guessed, along with
ready-made songs whose Spotify year differs from the deck's.

It runs on GitHub: the **Look up Spotify data** workflow (Actions tab, or every 6 hours
until everything is looked up). It needs two repository secrets, `SPOTIFY_CLIENT_ID` and
`SPOTIFY_CLIENT_SECRET`, from the Spotify app's dashboard (Settings → Secrets and
variables → Actions). Spotify's request quota is shared by every app on the developer
account, so a run makes at most 300 requests, one every 1.5 seconds, and stops by itself
if Spotify asks for a long pause; the next run carries on (`scripts/spotify-progress.json`).
Results go to the `spotify-data` branch and a pull request from it.

## Setting up a game

Setup asks one thing per screen, in three steps:

1. **Spotify:** play with a Spotify login or without one. Choosing a login sends you to
   Spotify right away (with permission to read your playlists), and you come back to step 2.
   This choice also decides how the music plays: with a Premium login it plays right here
   in the browser, otherwise through the hidden Spotify player.
2. **Music:** **Ready-made lists** or **Make your own**.
   - **Ready-made lists:** tick one or more of the decks above. No Spotify requests.
   - **Make your own:** **By genre** (works without login) or **From my playlists**
     (needs the login), or
     **Use my last list** to play the list built last time again without any requests.
3. **Players & play:** players or teams, cards needed to win, and **Start game**.

### Fetched a few songs at a time

Your own lists aren't loaded up front. **Build my list** / **Use N playlists** fetch one
batch (one request, a dozen or more songs) and the game starts; whenever only a few songs
are left in the deck, the next batch is fetched in the background. A short game therefore
costs two or three requests. Each batch is a random pick, so the songs stay random within
what you chose, and a page that was fetched once is not fetched again. Where to fetch the
next batch from is saved with the game, so a reload carries on. **Use my last list** starts
with the songs from last time and fetches new ones from where it left off.

### By genre

Pick 1 to 4 genres and a year span. The list comes from the game's own genre lists
(`src/data/spotify/genre-pools.json`): well-known songs per genre and decade, each with
its original year and Spotify id, so building it makes **no Spotify requests** and works
without a login. Only when those lists hold fewer than 40 songs for the pick (and you are
logged in) does the game mix in its classic hits for the same wider genres and fetch
batches from Spotify while you play. Each batch is one Spotify search such as
`genre:"rock" year:1980-1989`: the decades take turns (the one searched least so far, wide
spans with many genres search neighbouring decades together), with a random genre and a
random depth in the first 250 results, so the songs are known ones. Whenever songs are
added, the deck is dealt again spread over the decades, so a batch from one decade
doesn't come up all in a row. Songs on compilations, "Remastered"
albums and the like are skipped, so every song is dated by its own album and no further
lookups are needed. Searches are remembered for a week.

### From my playlists

Opening the screen makes ONE request (`/me/playlists`) that lists up to 50 playlists with
name, cover and number of songs; **Show more** fetches the next 50 only when tapped. Tick
the playlists to use. Each batch is one random page of 50 songs from one of them (bigger
playlists are picked more often). Songs that look like reissues (a compilation, an album
called "Remastered" or "Greatest Hits", or a title like "Song - Remastered 2011") need a
search for the original year; at most three are checked per batch, and everything else is
dated by its album. Year lookups are remembered in the browser.

If Spotify answers "too many requests" with a short pause (up to two minutes), the loading
screen counts down and carries on by itself.

Spotify also gives Development Mode apps a request quota, shared by all apps of the same
developer account and not shown in the dashboard. When it is used up, Spotify answers
`429` with `"reason": "QUOTA_EXCEEDED"` and a `Retry-After` that can be hours. The game
then stops asking until that time (remembered across reloads) and carries on without
Spotify: **By genre** fills the list (or the rest of the game) with the game's own classic hits for the same genres
and years, the music plays through the hidden player, and the setup screen says until
when. Nothing needs to be tapped.

The list is built in the browser and kept in its `localStorage` only; nothing is uploaded.
While the game's Spotify app is in development mode, Spotify only lets accounts log in
that are added as users of the app in the Spotify developer dashboard.

The code: `src/spotify/listening.ts` (requests and storing) and
`src/spotify/personalDeck.ts` (turning tracks into cards, tested in `personalDeck.test.ts`).

## Decades

With ready-made lists, the game spreads the songs evenly over the decades: each
draw picks a decade first and then a song from it, so a deck that is mostly recent
music still brings up older songs regularly (`spreadByDecade` in `src/game/engine.ts`).
A list you make yourself is simply shuffled.

## Fun facts

When a song is revealed, a short fun fact appears under the card.

Songs in the built-in decks have facts written for them in `src/data/facts.ts`
(345 of the 360 songs). They need no network, so they appear right away. To add one, append
`[title, artist, fact]` to the deck's list; `facts.test.ts` checks that the title and artist
match a song. Leave a song out rather than add a fact you aren't sure of.

Every other song, including your own lists, gets a few lines from English
Wikipedia instead, with a link to the article. If the song has no article of its own, the
lines are about the artist; soundtrack songs only get lines about the song itself. The
lookup starts while the song is playing, so it is usually ready when the guess is locked in.

A Wikipedia article is only used when its title matches the song (or artist) and the
text names the artist (or the film, show, game or musical), so a song that shares its
title with another doesn't get the other song's facts. When nothing matches, or Wikipedia
can't be reached, the reveal shows no fact. Wikipedia's API needs no key and works from
the browser.

The code: `src/facts/index.ts` (picks the fact), `src/facts/wikipedia.ts` (the lookup,
tested in `wikipedia.test.ts`) and `src/data/facts.ts` (the written facts).

## Music playback

Step 1 of setup decides how the music plays:

| Step 1 choice | What you get |
| --- | --- |
| Log in with Spotify (Premium) | Full songs via the [Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk). The browser tab becomes a Spotify device. If it can't start, the game offers the hidden player instead. |
| Log in with Spotify (Free) | The hidden player below, for any song. |
| Play without login | A covered-up [Spotify Embed](https://developer.spotify.com/documentation/embeds) player. Uses the songs that have a known Spotify id. Full songs if the browser is signed in to Spotify, otherwise 30-second previews. |

The music plays from the device the game is open on, so it goes wherever that device
sends its sound: its own speaker, headphones, Bluetooth or AirPlay. To play on a Sonos
from the game instead, see [Playing on a Sonos](#playing-on-a-sonos) below.

While the song is hidden, the game reports it as **Mystery song** to the device's
lock screen, Control Center, car displays and AirPlay/Bluetooth receivers (such as the
Sonos app), and their play/pause buttons control the song. Spotify's players run in an
iframe and report the real title, and Chrome only takes media info from a frame that has
a player of its own, so the game also plays a silent, looping clip in the page while
the song is hidden (`src/spotify/nowPlaying.ts`). The clip starts with the **Play song**
tap, since Safari only allows sound started by a tap. If the browser stops the clip by
itself (for example when headphones are unplugged), the song is paused too, so the title
doesn't slip out. After the reveal the real title may show.

This works in Chrome, Edge and Firefox on computers and Android. On iPhone and iPad the
silent clip is left out, since Safari may pause the song for it, so the title may still
show there, also on a Sonos the iPhone AirPlays to. Safari on a Mac is untested.

During a song, **Open in Spotify ↗** opens it in the Spotify app instead, which can play
on any speaker it reaches (Sonos included). Spotify shows the title there, so someone who
isn't guessing should tap it.

Songs with a Spotify id in `SPOTIFY_IDS` (`src/data/songs.ts`) play without a login.
Other songs are looked up with the Spotify search API, which needs the login.

### Playing on a Sonos

The game can play the mystery songs on a Sonos speaker or group through the **Sonos
bridge**: a small program in [`bridge/`](bridge/README.md) that runs on a computer (for
example a Mac or a Raspberry Pi) on the same Wi-Fi as the speakers.

1. Start the bridge (`cd bridge && npm install && npm start`). It shows a six-letter
   speaker code.
2. In the game, tap **🔊 This device** at the bottom, enter the code, tap **Find Sonos
   speakers** and pick one.

Nothing then plays on the host device; the game tells the speaker which Spotify song to
play, and the speaker plays it with the Spotify account added in the Sonos app. The songs
are found as for the other players (a known Spotify id, or a search with the login).
The choice is remembered, and **Play on this device instead** appears if the speaker
can't be reached.

Why a bridge: Spotify doesn't let apps control Sonos speakers (an earlier Spotify
speaker picker failed with "Restriction violated"), and a web page can't reach devices
on the home network. The bridge connects to the game over WebRTC like the phones do, and
controls the speakers over the network the way the Sonos app does.

The code: `src/sonos/bridge.ts` (the link to the bridge), `src/sonos/playback.ts`,
`src/components/SonosPicker.tsx` and `bridge/`.

### Spotify setup (only for "Log in with Spotify")

The game ships with its own Spotify app (Client ID `a96f51d734d240cdbe07ab7ae00fd959` in
`src/spotify/auth.ts`). A Client ID is public; the PKCE login uses no secret. The app's
owner manages it in the [Spotify dashboard](https://developer.spotify.com/dashboard):
its Redirect URIs must include `https://dybecks.github.io/the-musicquiz/` (and the
`127.0.0.1` ones below for local development), and while it is in *Development mode*
every account that logs in must be listed under **User Management**.

To use a different Spotify app instead:

1. Create an app at <https://developer.spotify.com/dashboard>, choosing **Web API** and **Web Playback SDK**.
2. Add the redirect URIs you'll use, for example `http://127.0.0.1:5173/` (dev) and
   `http://127.0.0.1:4173/` (preview). Spotify does not accept `localhost`; use `127.0.0.1`.
   For the deployed game, add `https://dybecks.github.io/the-musicquiz/`.
3. Put its **Client ID** in `.env` as `VITE_SPOTIFY_CLIENT_ID`, or paste it under "Use your own Spotify app" on the setup screen.
4. While the app is in Spotify's *Development mode*, add the Spotify account(s)
   that will log in under **User Management** in the dashboard. This also applies to
   building a deck from your own music, which needs the same login.

The login uses the Authorization Code + PKCE flow, so there is no backend and no client secret.

## Screen sizes and Android

The layout adapts to the screen (`src/styles.css`, "Screen sizes"):

| Screen | Layout |
| --- | --- |
| Phones, upright | One column. The **Lock in guess** button stays pinned to the bottom while you scroll the timeline. |
| Phones on their side, tablets, laptops | Two columns: the turn and the play button stay put on the left, the timeline scrolls on the right. Short landscape screens get tighter spacing. |
| Tablets and up (900px+) | The setup screen uses two columns too. |

Text scales with the screen width, buttons are at least 44px tall for fingers, and
on phones with a notch or gesture bar the content stays inside the safe area.

### Getting ready for an Android app

The game is a Progressive Web App: `public/manifest.webmanifest`, icons in `public/icons/`
and a service worker (`public/sw.js`) that caches the game's own files (never Spotify).
On Android, Chrome's **Add to Home screen / Install app** already gives a full-screen
app with its own icon.

To publish on Google Play, the plan is a **Trusted Web Activity**: a small Android app that
opens the deployed site in Chrome without browser UI. It keeps one codebase, and the Spotify
login keeps working because the redirect URI stays `https://dybecks.github.io/the-musicquiz/`.

1. Generate the Android project from the manifest with [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap)
   (`npx @bubblewrap/cli init --manifest https://dybecks.github.io/the-musicquiz/manifest.webmanifest`)
   or [PWABuilder](https://www.pwabuilder.com/).
2. Publish a Digital Asset Links file proving the site and app belong together. A TWA checks it at
   `https://dybecks.github.io/.well-known/assetlinks.json`, the root of the domain rather than
   `/the-musicquiz/`, so it has to be served from a `dybecks.github.io` repository or a custom domain.
3. Build the signed bundle and upload it to the Play Console.

Still to work out:

- **Playback on Android.** Spotify's Web Playback SDK ("Log in with Spotify") doesn't support mobile
  browsers, so on phones the hidden Spotify player is the option that works. Full in-app
  playback on Android would need Spotify's native Android SDK, so a native wrapper (for example
  Capacitor) instead of a TWA.
- Test on real devices (small phones, foldables, tablets), and add Play Store screenshots and a privacy policy.

## Deployment

Every push to `main` runs the tests, builds the app and deploys it to GitHub Pages at
<https://dybecks.github.io/the-musicquiz/> (`.github/workflows/deploy.yml`). Pull requests
run the tests and build but don't deploy.

One-time setup in the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
To deploy with a different Spotify app, set a repository variable `SPOTIFY_CLIENT_ID`
(Settings → Secrets and variables → Actions → Variables).

## Development

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm test           # game-rule tests
npm run build      # type check + production build in dist/
```

The project is Vite + React + TypeScript. The pieces:

- `src/game/engine.ts`: the rules as pure functions (deal, place, reveal, next turn, win).
- `src/data/songs.ts`: the classic deck. Add `[title, artist, year]` rows to extend it.
  Years are the original release year, not a remaster's.
- `src/data/soundtracks.ts`: the movie, musical, TV and video game decks, as
  `[title, artist, year, from]` rows. `src/data/decks.ts` combines the chosen decks.
- `src/spotify/`: login (`auth.ts`), Web API calls (`api.ts`) and the playback options (`playback.ts`).
- `src/components/`: setup screen, game screen and timeline.
- `bridge/`: the Sonos bridge, a separate Node program (`cd bridge && npm test`).
