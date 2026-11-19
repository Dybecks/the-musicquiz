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
| My Spotify music | varies | See below |

The four soundtrack decks are in `src/data/soundtracks.ts`. They only hold songs written
for the film, show, game or musical, so the year on the card is the year that work first
came out: the film's release, the show's premiere, the game's first release, or the
musical's first major production (or concept album, as for Evita). Cards say where the
song is from. None of these songs has a pinned Spotify id yet, so they are found with the
Spotify search at play time, which needs a Spotify login. Some video game music, Nintendo's
in particular, isn't on Spotify; the search may then find a cover, or nothing, and
**Skip song** draws another.

## Play with your own music

The host can also play with songs they actually listen to. Under **Which songs?** tick
**My Spotify music** (on its own or with other decks), tick what to share and press
**Allow access and build my deck**:

| Share | Spotify permission | What is read |
| --- | --- | --- |
| Top tracks | `user-top-read` | Top 50 tracks for the last month, 6 months and year |
| Recently played | `user-read-recently-played` | The last 50 played tracks |
| Liked songs | `user-library-read` | Up to 200 saved tracks |

Nothing is read until the person opts in, and Spotify shows its own consent screen
for exactly the permissions ticked. The deck is built in the browser and stored in
its `localStorage` only; nothing is uploaded. **Delete my Spotify songs** removes it.
Logging out keeps the deck, and because every card has a Spotify track id it plays
with any of the playback options below, including the hidden player.

Spotify dates a track by the album it's on, so a 1975 song on a 2011 remaster says 2011.
For each track the game searches Spotify for other releases of the same title by the
same artist and uses the earliest year. Repeats, other versions of the same song and
local files are dropped, and at most 300 songs are used. The setup screen shows how
the songs spread over the decades; a deck of mostly recent songs is hard to place,
so ticking another deck as well adds spread.

The code: `src/spotify/listening.ts` (reading and storing) and
`src/spotify/personalDeck.ts` (turning tracks into cards, tested in `personalDeck.test.ts`).

**Phase two, several people:** the stored deck is already a list of contributors
(`PersonalDeck.contributors`), each with their own songs, so letting more players
log in one after another and merge their music only needs the login and UI for it.

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
   For the deployed game, add `https://dybecks.github.io/the-musicquiz/`.
3. Copy the **Client ID** into `.env` as `VITE_SPOTIFY_CLIENT_ID`, or paste it into the setup screen.
4. While the app is in Spotify's *Development mode*, add the Spotify account(s)
   that will log in under **User Management** in the dashboard. This also applies to
   building a deck from your own music, which needs the same login.

The login uses the Authorization Code + PKCE flow, so there is no backend and no client secret.

## Deployment

Every push to `main` runs the tests, builds the app and deploys it to GitHub Pages at
<https://dybecks.github.io/the-musicquiz/> (`.github/workflows/deploy.yml`). Pull requests
run the tests and build but don't deploy.

One-time setup in the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
Optionally add a repository variable `SPOTIFY_CLIENT_ID` (Settings → Secrets and variables →
Actions → Variables) so players don't have to paste the Client ID.

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
