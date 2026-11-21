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
3. On your turn the song starts by itself (or press **Play song**) and you listen. The title stays hidden.
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
   (**Play again**) until **Stop sharing** or **End game**, which sends every phone
   out of the game right away.
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
6. After the reveal, the next song starts as the host chose under **Who starts the next
   song**: **Most players** (more than half of the connected phones tap **Next song**; the
   default), **Any player** (one tap is enough) or **Only me**. With the first two, phones
   can also play and pause the song. The host's own **Next** button always works.

Team members can rename their own team from their phone (**✎ Rename**), and the host can
rename any team with ✎ in the share panel; the new name shows everywhere and is kept for the
next game. The host taps a player's name in the share panel to move them to another team
or **Remove from the game**. A removed phone is sent out at once and can't join that game
again until the host taps **let back in**.

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
| Movie songs | 49 | The Wizard of Oz (1939) to Barbie (2023) |
| Musicals | 45 | Oklahoma! (1943) to Beetlejuice (2019) |
| TV themes | 33 | Peter Gunn (1958) to Arcane (2021) |
| Video game music | 38 | Super Mario Bros. (1985) to Baldur's Gate 3 (2023) |

All decks are lists of songs from the song catalogue (see **The song catalogue** below).
The four soundtrack decks only hold songs written
for the film, show, game or musical, so the year on the card is the year that work first
came out: the film's release, the show's premiere, the game's first release, or the
musical's first major production (or concept album, as for Evita). Cards say where the
song is from. Some video game music, Nintendo's in particular, isn't on Spotify;
songs Spotify doesn't have under their title and artist were taken out of the decks.

## The song catalogue

Every song the game knows is one row in `src/data/catalog/songs.json`:

```json
{"id":"5kI61e8YOAxhQO7UBKQ0CW","title":"Waterloo","artist":"ABBA","year":1974,"genres":["pop","swedishpop"]}
```

- `id`: the Spotify track id, so the song plays in the hidden player without a login or
  a request;
- `title`, `artist`, and `year`: the original release year (single or album, whichever
  came first), not a remaster's;
- `genres`: the **By genre** genres it belongs to (`src/data/searchGenres.ts`);
- `from`: for soundtracks, the film, show, game or musical.

The ready-made decks are lists of Spotify ids from the catalogue, in
`src/data/catalog/decks.json`. **By genre** picks from the whole catalogue
(`src/data/catalog.ts`). Tests check that every row is valid, that no song is in twice,
and that every deck song is in the catalogue with an id.

To add a song, add a row with `"id": null` (and add it to a deck by id once it has one).
Rows without an id stay out of the game until `scripts/spotify-precompute.ts` looks them
up: Wikidata first (checked with Spotify's public oEmbed, which costs no API requests),
then at most two Spotify searches each. Songs Spotify doesn't have are taken out of the
catalogue, never guessed. `src/data/catalog/REVIEW.md` lists them, songs not looked up
yet, years that differ from Spotify's, and how many songs each genre has per decade.

The same script sets each song's genres from the tags people gave that recording on
MusicBrainz (no key needed) and, if `LASTFM_API_KEY=…` is in `.env.local`, Last.fm. The
tags are mapped to the 16 genres in `src/data/genreTags.ts`; this costs no Spotify
requests, and `MAX_REQUESTS=0 npm run spotify-data` does only this part. Tags only
add genres, never take a hand-set one away, and only a genre with at least two votes
counts. Film, TV, game and stage songs keep their hand-set genres, and a song whose
genres you change by hand in `songs.json` is left alone from then on. What the sources said is kept in
`scripts/genre-progress.json`, so each song is only asked about once.

It is a local script. Put your Spotify app's values in `.env.local` (never committed) as
`SPOTIFY_CLIENT_ID=…` and `SPOTIFY_CLIENT_SECRET=…`, then run `npm run spotify-data` and
commit `src/data/catalog` and `scripts/spotify-progress.json` and
`scripts/genre-progress.json`. Spotify's request quota is
shared by every app on the developer account, so a run makes at most 300 requests
(`MAX_REQUESTS=…` changes that), one every 1.5 seconds, and stops by itself if Spotify asks
for a long pause. Running it again carries on where it stopped, and once everything is
looked up it makes no requests at all.

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

Playlist lists aren't loaded up front. **Use N playlists** fetches one
batch (one request, a dozen or more songs) and the game starts; whenever only a few songs
are left in the deck, the next batch is fetched in the background. A short game therefore
costs two or three requests. Each batch is a random pick, so the songs stay random within
what you chose, and a page that was fetched once is not fetched again. Where to fetch the
next batch from is saved with the game, so a reload carries on. **Use my last list** starts
with the songs from last time and fetches new ones from where it left off.

### By genre

Pick 1 to 4 genres and a year span. The list is every song in the song catalogue tagged
with one of the genres, from those years, each with its Spotify id. Building and playing
it makes **no Spotify requests** at all and works without a login. If a pick has fewer than
5 songs, the game asks for more genres or a wider year span.

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
Spotify: the music plays through the hidden player, and the setup screen says until
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
match a song. Leave a song out rather than add a fact you aren't sure of. Every written fact
also has a Swedish version in `src/data/facts.sv.ts`, shown when the game is in Swedish;
`facts.test.ts` fails if one is missing, so add both.

Every other song, including your own lists, gets a few lines from Wikipedia in the
game's language (English or Swedish Wikipedia) instead, with a link to the article. If the song has no article of its own, the
lines are about the artist; soundtrack songs only get lines about the song itself. The
lookup starts while the song is playing, so it is usually ready when the guess is locked in.

A Wikipedia article is only used when its title matches the song (or artist) and the
text names the artist (or the film, show, game or musical), so a song that shares its
title with another doesn't get the other song's facts. When nothing matches, or Wikipedia
can't be reached, the reveal shows no fact. Wikipedia's API needs no key and works from
the browser.

The code: `src/facts/index.ts` (picks the fact), `src/facts/wikipedia.ts` (the lookup,
tested in `wikipedia.test.ts`) and `src/data/facts.ts` (the written facts).

## Languages

The whole site is in English and Swedish. The **EN / SV** switch in the top corner changes
the language right away, mid-game too, and is remembered on that device. The first time,
the game picks Swedish if the browser's language is Swedish, otherwise English. Each phone
that joins a game has its own language, so a Swedish host and an English-speaking guest
each see the game in their own language.

Every text a player can see lives in `src/i18n/en.ts` and `src/i18n/sv.ts`. To add or
change a text:

1. Add it to `en.ts`, in the section for the screen it belongs to. Texts with numbers or
   names in them are functions, like `` songsLeft: (n: number) => `${n} songs left` ``.
2. Add the Swedish version to `sv.ts`. The build fails until you do: `sv.ts` must have
   exactly the same texts as `en.ts`.
3. Use it: `const t = useT()` in a component (`t.game.songsLeft(n)`), or `msg()` in other
   code, such as error messages. Wrap a text in `<Rich text={…} />` to show `**bold**` parts.

`src/i18n/i18n.test.ts` fails if a component, a `title`/`aria-label`/`placeholder`, an
error message or a `confirm()` has text written straight into it, so no English-only
text slips in. Song titles, artists and team names are never translated.

## Music playback

Step 1 of setup decides how the music plays:

| Step 1 choice | What you get |
| --- | --- |
| Log in with Spotify (Premium) | Full songs via the [Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk). The browser tab becomes a Spotify device. If it can't start, the game offers the hidden player instead. |
| Log in with Spotify (Free) | The hidden player below, for any song. |
| Play without login | A covered-up [Spotify Embed](https://developer.spotify.com/documentation/embeds) player. Uses the songs that have a known Spotify id. Full songs if the browser is signed in to Spotify, otherwise 30-second previews. |

The music plays from the device the game is open on, so it goes wherever that device
sends its sound: its own speaker, headphones, Bluetooth or AirPlay. To play on a bigger
speaker (a Sonos, say), connect that device to it. The game has no speaker picker of its
own: Spotify won't let outside apps control many speakers (a grouped Sonos answers
"Restricted device"), so it was removed.

With the login, a song moved to another device in the Spotify app keeps playing there:
after the first song, play, pause and the next songs go to wherever Spotify plays, with no
device id. A speaker Spotify locks for apps can't be controlled that way; the game then
says to use the Spotify app, or to pick "The Music Quiz" there to play in the browser again.

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

Every song in the catalogue has a Spotify id, so the ready-made decks play without a
login.

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
- `src/data/catalog/`: the song catalogue (`songs.json`) and the ready-made decks as id
  lists (`decks.json`); see [The song catalogue](#the-song-catalogue).
  `src/data/decks.ts` combines the chosen decks.
- `src/spotify/`: login (`auth.ts`), Web API calls (`api.ts`) and the playback options (`playback.ts`).
- `src/components/`: setup screen, game screen and timeline.
- `src/i18n/`: the English and Swedish texts (see [Languages](#languages)).
