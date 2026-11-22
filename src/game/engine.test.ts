import { describe, expect, it } from 'vitest';
import { addSongs, applyPower, canUsePower, createGame, currentPlayer, insertSorted, isCorrectPlacement, makeQuestion, nextTurn, placeCurrent, scoreOf, skipSong, spreadByDecade, type GameState, type Song } from './engine';

const song = (year: number, id = `s${year}`): Song => ({ id, title: `Song ${year}`, artist: 'Artist', year });
const songs = [1960, 1970, 1980, 1990, 2000, 2010, 2020].map((y) => song(y));
// Deterministic "rng" that never shuffles (always picks the last index).
const noShuffle = () => 0.999999;

describe('isCorrectPlacement', () => {
  const timeline = [song(1970), song(1990)];
  it('accepts a year before the first card', () => expect(isCorrectPlacement(timeline, 0, 1965)).toBe(true));
  it('accepts a year between cards', () => expect(isCorrectPlacement(timeline, 1, 1980)).toBe(true));
  it('accepts a year after the last card', () => expect(isCorrectPlacement(timeline, 2, 2005)).toBe(true));
  it('rejects a wrong slot', () => {
    expect(isCorrectPlacement(timeline, 0, 1980)).toBe(false);
    expect(isCorrectPlacement(timeline, 2, 1980)).toBe(false);
  });
  it('treats equal years as correct on both sides', () => {
    expect(isCorrectPlacement(timeline, 0, 1970)).toBe(true);
    expect(isCorrectPlacement(timeline, 1, 1970)).toBe(true);
  });
  it('rejects out-of-range slots', () => expect(isCorrectPlacement(timeline, 5, 1980)).toBe(false));
});

describe('insertSorted', () => {
  it('keeps the timeline ordered by year', () => {
    expect(insertSorted([song(1970), song(1990)], song(1980)).map((s) => s.year)).toEqual([1970, 1980, 1990]);
  });
});

describe('game flow', () => {
  it('deals one starting card per player and draws a song', () => {
    const g = createGame({ playerNames: ['A', 'B'], targetCards: 3, songs, rng: noShuffle });
    expect(g.players.map((p) => p.timeline.length)).toEqual([1, 1]);
    expect(g.current).not.toBeNull();
    expect(g.deck.length).toBe(songs.length - 3);
  });

  it('adds the card on a correct guess and moves to the next player', () => {
    let g = createGame({ playerNames: ['A', 'B'], targetCards: 3, songs, rng: noShuffle });
    const start = g.players[0].timeline[0].year;
    const slot = g.current!.year < start ? 0 : 1;
    g = placeCurrent(g, slot);
    expect(g.lastGuess?.correct).toBe(true);
    expect(g.players[0].timeline).toHaveLength(2);
    g = nextTurn(g);
    expect(g.currentPlayerIndex).toBe(1);
    expect(g.phase).toBe('guessing');
  });

  it('discards the card on a wrong guess', () => {
    let g = createGame({ playerNames: ['A'], targetCards: 3, songs, rng: noShuffle });
    const start = g.players[0].timeline[0].year;
    const wrongSlot = g.current!.year < start ? 1 : 0;
    g = placeCurrent(g, wrongSlot);
    expect(g.lastGuess?.correct).toBe(false);
    expect(g.players[0].timeline).toHaveLength(1);
  });

  it('ends the game when a player reaches the target', () => {
    let g = createGame({ playerNames: ['A'], targetCards: 2, songs, rng: noShuffle });
    const start = g.players[0].timeline[0].year;
    g = placeCurrent(g, g.current!.year < start ? 0 : 1);
    expect(g.winnerIds).toEqual(['p1']);
    g = nextTurn(g);
    expect(g.phase).toBe('finished');
  });

  it('ends with the most cards when the deck runs out', () => {
    let g = createGame({ playerNames: ['A', 'B'], targetCards: 99, songs: songs.slice(0, 3), rng: noShuffle });
    g = nextTurn(placeCurrent(g, 99)); // invalid slot = wrong guess, deck now empty
    expect(g.phase).toBe('finished');
    expect(g.winnerIds).toEqual(['p1', 'p2']);
  });

  it('skipSong swaps the current song without changing the player', () => {
    const g = createGame({ playerNames: ['A', 'B'], targetCards: 3, songs, rng: noShuffle });
    const skipped = skipSong(g);
    expect(skipped.current?.id).not.toBe(g.current?.id);
    expect(skipped.currentPlayerIndex).toBe(0);
  });
});

describe('default deck', () => {
  it('has enough songs with Spotify ids to play without logging in', async () => {
    const DEFAULT_SONGS = (await import('../data/decks')).BUILT_IN.classic;
    expect(DEFAULT_SONGS.length).toBeGreaterThanOrEqual(50);
    expect(DEFAULT_SONGS.every((s) => /^[0-9A-Za-z]{22}$/.test(s.spotifyId ?? ''))).toBe(true);
    expect(new Set(DEFAULT_SONGS.map((s) => s.id)).size).toBe(DEFAULT_SONGS.length);
  });
});

describe('spreadByDecade', () => {
  it('draws each decade about equally often, however many songs it has', () => {
    // 90 songs from the 2010s, 10 from the 1970s.
    const many = [...Array.from({ length: 90 }, (_, i) => song(2010 + (i % 10), `n${i}`)), ...Array.from({ length: 10 }, (_, i) => song(1970 + i, `o${i}`))];
    let seventies = 0;
    for (let run = 0; run < 50; run++) seventies += spreadByDecade(many).slice(0, 10).filter((s) => s.year < 1980).length;
    // A plain shuffle would give about 1 in 10; spreading gives about 5 in 10.
    expect(seventies / 50).toBeGreaterThan(3);
  });

  it('keeps every song exactly once', () => {
    const out = spreadByDecade(songs);
    expect(out.map((s) => s.id).sort()).toEqual(songs.map((s) => s.id).sort());
  });
});

describe('addSongs', () => {
  it('appends new songs and leaves out ones already dealt or in the deck', () => {
    const g = createGame({ playerNames: ['A'], targetCards: 3, songs: songs.slice(0, 3), rng: noShuffle });
    const dealt = g.players[0].timeline[0];
    const next = addSongs(g, [dealt, g.deck[0], song(1955), song(1955, 'other-release')], { more: true }, noShuffle);
    expect(next.deck.map((s) => s.year).sort()).toEqual([...g.deck.map((s) => s.year), 1955].sort());
    expect(next.refill).toEqual({ more: true });
  });
  it('mixes a batch from one decade in with the rest instead of queueing it at the end', () => {
    const g = { ...createGame({ playerNames: ['A'], targetCards: 5, songs: [1990, 1991, 1992, 1993, 1994, 1995].map((y) => song(y)) }), deck: [] };
    const nineties = [1996, 1997, 1998, 1999].map((y) => song(y));
    const eighties = [1981, 1982, 1983, 1984].map((y) => song(y));
    let mixedFirstHalf = 0;
    for (let i = 0; i < 50; i++) {
      const deck = addSongs(addSongs(g, nineties, undefined), eighties, undefined).deck;
      if (deck.slice(0, 4).some((s) => s.year < 1990)) mixedFirstHalf++;
    }
    expect(mixedFirstHalf).toBeGreaterThan(40);
  });
  it('remembers drawn songs so they are not added again', () => {
    let g = createGame({ playerNames: ['A'], targetCards: 5, songs, rng: noShuffle });
    const first = g.current!;
    g = skipSong(g);
    expect(addSongs(g, [first], undefined).deck).toHaveLength(g.deck.length);
  });
});

describe('bonus questions', () => {
  const band = (year: number, i: number): Song => ({ id: `b${i}`, title: `Title ${i}`, artist: `Band ${i}`, year });
  const many = Array.from({ length: 12 }, (_, i) => band(1960 + i * 5, i));

  it('asks with the right answer and three different wrong ones', () => {
    const q = makeQuestion(many[0], many)!;
    expect(q.choices).toHaveLength(4);
    expect(new Set(q.choices).size).toBe(4);
    const right = q.kind === 'artist' ? many[0].artist : many[0].title;
    expect(q.choices[q.answer]).toBe(right);
  });

  it('never offers the same artist as a wrong answer', () => {
    const pool = [...many, { ...many[1], id: 'x', artist: 'Band 0' }];
    for (let i = 0; i < 20; i++) {
      const q = makeQuestion(many[0], pool)!;
      expect(q.choices.filter((c) => c === 'Band 0').length).toBeLessThanOrEqual(1);
    }
  });

  it('asks where a soundtrack song is from', () => {
    const films = many.map((s, i) => ({ ...s, from: `Film ${i}` }));
    const q = makeQuestion(films[3], films)!;
    expect(q.kind).toBe('from');
    expect(q.choices[q.answer]).toBe('Film 3');
  });

  it('gives up when there are too few different answers', () => {
    expect(makeQuestion(many[0], many.slice(0, 2))).toBeNull();
  });

  it('gives a star for the right answer, and stars count toward the target', () => {
    let g = createGame({ playerNames: ['A', 'B'], targetCards: 3, songs: many, mode: 'bonus' });
    expect(g.question).toBeTruthy();
    const q = g.question!;
    g = placeCurrent(g, 0, q.answer);
    expect(g.players[0].stars).toBe(1);
    expect(g.lastGuess?.bonus).toMatchObject({ pick: q.answer, correct: true });
    expect(scoreOf(g.players[0])).toBe(g.players[0].timeline.length + 1);
  });

  it('gives no star for a wrong or missing answer', () => {
    let g = createGame({ playerNames: ['A'], targetCards: 5, songs: many, mode: 'bonus' });
    g = placeCurrent(g, 0, (g.question!.answer + 1) % g.question!.choices.length);
    expect(g.players[0].stars ?? 0).toBe(0);
    g = nextTurn(g);
    expect(g.question).toBeTruthy();
    g = placeCurrent(g, 0, null);
    expect(g.players[0].stars ?? 0).toBe(0);
    expect(g.lastGuess?.bonus?.pick).toBeNull();
  });

  it('wins on cards plus stars', () => {
    let g = createGame({ playerNames: ['A', 'B'], targetCards: 2, songs: many, mode: 'bonus' });
    // A wrong spot but the right answer: 1 card + 1 star.
    const year = g.current!.year;
    const start = g.players[0].timeline[0].year;
    const wrongSlot = year >= start ? 0 : 1;
    g = placeCurrent(g, year === start ? 99 : wrongSlot, g.question!.answer);
    expect(g.winnerIds).toEqual(['p1']);
  });

  it('asks nothing in classic', () => {
    const g = createGame({ playerNames: ['A'], targetCards: 3, songs: many });
    expect(g.question).toBeUndefined();
    expect(placeCurrent(g, 0, 0).lastGuess?.bonus).toBeUndefined();
  });

  it('asks a new question for a skipped song', () => {
    const g = createGame({ playerNames: ['A'], targetCards: 3, songs: many, mode: 'bonus' });
    const s = skipSong(g);
    expect(s.current?.id).not.toBe(g.current?.id);
    const q = s.question!;
    const right = q.kind === 'artist' ? s.current!.artist : s.current!.title;
    expect(q.choices[q.answer]).toBe(right);
  });
});

describe('steal', () => {
  const many = Array.from({ length: 20 }, (_, i): Song => ({ id: `t${i}`, title: `T${i}`, artist: `A${i}`, year: 1950 + i * 3 }));
  /** A slot that is wrong for the current song on the current timeline. */
  const wrongSlot = (g: GameState) => {
    const tl = currentPlayer(g).timeline;
    for (let i = 0; i <= tl.length; i++) if (!isCorrectPlacement(tl, i, g.current!.year)) return i;
    return 99;
  };
  const rightSlot = (g: GameState) => {
    const tl = currentPlayer(g).timeline;
    for (let i = 0; i <= tl.length; i++) if (isCorrectPlacement(tl, i, g.current!.year)) return i;
    return 0;
  };

  it('gives a missed song to the next team, who then plays its own turn', () => {
    let g = createGame({ playerNames: ['A', 'B', 'C'], targetCards: 9, songs: many, mode: 'steal' });
    const song = g.current!;
    g = placeCurrent(g, wrongSlot(g));
    expect(g.lastGuess?.stealNext).toBe('p2');
    g = nextTurn(g);
    expect(g.stealing).toBe(true);
    expect(g.currentPlayerIndex).toBe(1);
    expect(g.current).toBe(song);
    g = placeCurrent(g, rightSlot(g));
    expect(g.lastGuess).toMatchObject({ steal: true, correct: true });
    expect(g.players[1].timeline).toContain(song);
    g = nextTurn(g);
    // B's own turn, with a new song.
    expect(g.currentPlayerIndex).toBe(1);
    expect(g.stealing).toBe(false);
    expect(g.current).not.toBe(song);
  });

  it('offers no steal of a missed steal', () => {
    let g = createGame({ playerNames: ['A', 'B'], targetCards: 9, songs: many, mode: 'steal' });
    g = nextTurn(placeCurrent(g, wrongSlot(g)));
    g = placeCurrent(g, wrongSlot(g));
    expect(g.lastGuess?.stealNext).toBeUndefined();
  });

  it('offers no steal in classic', () => {
    const g = createGame({ playerNames: ['A', 'B'], targetCards: 9, songs: many });
    expect(placeCurrent(g, wrongSlot(g)).lastGuess?.stealNext).toBeUndefined();
  });

  describe('sudden death', () => {
    it('puts a team out on a miss and skips it', () => {
      let g = createGame({ playerNames: ['A', 'B', 'C'], targetCards: 9, songs: many, mode: 'sudden' });
      g = placeCurrent(g, wrongSlot(g));
      expect(g.players[0].out).toBe(true);
      expect(g.lastGuess?.eliminated).toBe(true);
      g = nextTurn(g); // B
      g = nextTurn(placeCurrent(g, rightSlot(g))); // C
      g = nextTurn(placeCurrent(g, rightSlot(g)));
      expect(currentPlayer(g).name).toBe('B'); // A is passed over
    });

    it('ends when one team is left', () => {
      let g = createGame({ playerNames: ['A', 'B'], targetCards: 9, songs: many, mode: 'sudden' });
      g = placeCurrent(g, wrongSlot(g));
      expect(g.winnerIds).toEqual(['p2']);
      expect(nextTurn(g).phase).toBe('finished');
    });
  });

  describe('power-ups', () => {
    const game = () => createGame({ playerNames: ['A', 'B'], targetCards: 9, songs: many, mode: 'powerups' });

    it('starts with a coin and earns one per right placement', () => {
      let g = game();
      expect(g.players.map((p) => p.coins)).toEqual([1, 1]);
      g = placeCurrent(g, rightSlot(g));
      expect(g.players[0].coins).toBe(2);
      expect(g.lastGuess?.coin).toBe(true);
    });

    it('pays for a hint, once a turn, and not without coins', () => {
      let g = applyPower(game(), 'hint');
      expect(g.powers?.hint).toBe(true);
      expect(g.players[0].coins).toBe(0);
      expect(applyPower(g, 'hint')).toBe(g);
      expect(applyPower(g, 'retry')).toBe(g);
    });

    it('gives a second try with retry', () => {
      let g = game();
      g = { ...g, players: g.players.map((p) => ({ ...p, coins: 5 })) };
      g = applyPower(g, 'retry');
      const wrong = wrongSlot(g);
      g = placeCurrent(g, wrong);
      expect(g.phase).toBe('guessing');
      expect(g.powers?.missedSlot).toBe(wrong);
      g = placeCurrent(g, wrong);
      expect(g.phase).toBe('revealed');
    });

    it('freezes another team, who misses one turn', () => {
      let g = createGame({ playerNames: ['A', 'B', 'C'], targetCards: 9, songs: many, mode: 'powerups' });
      g = { ...g, players: g.players.map((p) => ({ ...p, coins: 5 })) };
      expect(applyPower(g, 'freeze', 'p1')).toBe(g); // not yourself
      g = applyPower(g, 'freeze', 'p2');
      expect(g.players[1].frozen).toBe(true);
      expect(g.players[0].coins).toBe(3);
      g = nextTurn(placeCurrent(g, 0));
      expect(currentPlayer(g).name).toBe('C');
      expect(g.players[1].frozen).toBe(false);
      g = nextTurn(placeCurrent(g, 0));
      g = nextTurn(placeCurrent(g, 0));
      expect(currentPlayer(g).name).toBe('B');
    });

    it('grabs a card from another team, who keeps at least one', () => {
      let g = game();
      g = { ...g, players: g.players.map((p) => ({ ...p, coins: 5 })) };
      expect(applyPower(g, 'grab', 'p2')).toBe(g); // B has one card
      const extra = many[19];
      g = { ...g, players: g.players.map((p) => (p.id === 'p2' ? { ...p, timeline: insertSorted(p.timeline, extra) } : p)) };
      g = applyPower(g, 'grab', 'p2');
      expect(g.players[0].timeline).toHaveLength(2);
      expect(g.players[1].timeline).toHaveLength(1);
      expect(g.players[0].coins).toBe(2);
      // One attack a turn.
      expect(canUsePower(g, 'freeze')).toBe(false);
    });
  });
});
