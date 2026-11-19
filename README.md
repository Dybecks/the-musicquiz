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

## Genres and years

The setup screen can narrow the deck to some genres (pop, rock, hip-hop & R&B,
dance & electronic, soul/funk/disco, Swedish artists) and a year span, or use a
quick pick such as "80s & 90s" or "Party". With a deck built from your own
Spotify music you also get two picks based on it: **Your era** (the years most of
your music comes from) and **Your genres** (the genres it leans towards).

Classic songs are tagged by artist in `src/data/songs.ts`. Your own songs get
their genres from the artist's genres on Spotify, folded into the categories above
(`src/data/genres.ts`). Songs with no known genre are left out when filtering by genre.

## Fun facts

When a song is revealed, a few lines about it from English Wikipedia appear under the
card, with a link to the article. If the song has no article of its own, the facts are
about the artist; soundtrack songs only get facts about the song itself. The lookup
starts while the song is playing, so it is usually ready when the guess is locked in.

A Wikipedia article is only used when its title matches the song (or artist) and the
text names the artist (or the film, show, game or musical), so a song that shares its
title with another doesn't get the other song's facts. When nothing matches, or Wikipedia
can't be reached, the reveal shows no fact. Wikipedia's API needs no key and works from
the browser, so this works for every deck, including your own Spotify music.

The code: `src/facts/wikipedia.ts`, tested in `wikipedia.test.ts`.

## Music playback

On the setup screen the host chooses how the music plays:

| Option | Needs | What you get |
| --- | --- | --- |
| Log in with Spotify | Premium account | Full songs via the [Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk), from the whole deck. The browser tab becomes a Spotify device. |
| Hidden Spotify player, no login | Nothing | A covered-up [Spotify Embed](https://developer.spotify.com/documentation/embeds) player. Uses the songs that have a known Spotify id (65 of them). Full songs if the browser is signed in to Spotify, otherwise 30-second previews. If the host is also logged in, it can use the whole deck. |
| No audio | Nothing | Try the rules, or play the music some other way. |

Songs with a Spotify id in `SPOTIFY_IDS` (`src/data/songs.ts`) play without a login.
Other songs are looked up with the Spotify search API, which needs the login.

### Spotify setup (only for "Log in with Spotify")

The game ships with its own Spotify app (Client ID `5a008c63808c47478e4edcc99db34a87` in
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
