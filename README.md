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

## Music playback

On the setup screen the host chooses how the music plays:

| Option | Needs | What you get |
| --- | --- | --- |
| Log in with Spotify | Premium account + a Spotify app Client ID | Full songs via the [Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk), from the whole deck. The browser tab becomes a Spotify device. |
| Hidden Spotify player, no login | Nothing | A covered-up [Spotify Embed](https://developer.spotify.com/documentation/embeds) player. Uses the songs that have a known Spotify id (65 of them). Full songs if the browser is signed in to Spotify, otherwise 30-second previews. If the host is also logged in, it can use the whole deck. |
| No audio | Nothing | Try the rules, or play the music some other way. |

Songs with a Spotify id in `SPOTIFY_IDS` (`src/data/songs.ts`) play without a login.
Other songs are looked up with the Spotify search API, which needs the login.

### Spotify setup (only for "Log in with Spotify")

1. Create an app at <https://developer.spotify.com/dashboard>, choosing **Web API** and **Web Playback SDK**.
2. Add the redirect URIs you'll use, for example `http://127.0.0.1:5173/` (dev) and
   `http://127.0.0.1:4173/` (preview). Spotify does not accept `localhost`; use `127.0.0.1`.
   When the game is deployed, add its public URL too (it must be `https`).
3. Copy the **Client ID** into `.env` as `VITE_SPOTIFY_CLIENT_ID`, or paste it into the setup screen.
4. While the app is in Spotify's *Development mode*, add the Spotify account(s)
   that will log in under **User Management** in the dashboard.

The login uses the Authorization Code + PKCE flow, so there is no backend and no client secret.

## Development

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm test           # game-rule tests
npm run build      # type check + production build in dist/
```

The project is Vite + React + TypeScript. The pieces:

- `src/game/engine.ts`: the rules as pure functions (deal, place, reveal, next turn, win).
- `src/data/songs.ts`: the song deck. Add `[title, artist, year]` rows to extend it.
  Years are the original release year, not a remaster's.
- `src/spotify/`: login (`auth.ts`), Web API calls (`api.ts`) and the playback options (`playback.ts`).
- `src/components/`: setup screen, game screen and timeline.
