// src/logic/deck.ts
// Core cards + utils for Mindi Kot per your rules

import seedrandom from 'seedrandom';

export type Suit = 'S' | 'H' | 'D' | 'C'; // Spades, Hearts, Diamonds, Clubs
export type Rank = 'A'|'K'|'Q'|'J'|'T'|'9'|'8'|'7'|'6'|'5'|'4'|'3'; // NO 2s
export type Card = `${Rank}${Suit}`;

export const RANKS: Rank[] = ['A','K','Q','J','T','9','8','7','6','5','4','3'];
export const SUITS: Suit[] = ['S','H','D','C'];

// Build a single deck (52 -> 48 usable because no 2s)
export function buildSingleDeckNoTwos(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(`${r}${s}` as Card);
  return deck;
}

// Build N decks (1 or 2) with no 2s
export function buildDecksNoTwos(deckCount: 1 | 2): Card[] {
  const one = buildSingleDeckNoTwos();
  return deckCount === 1 ? one.slice() : one.concat(one);
}

// Fisher-Yates with seed
export function shuffle<T>(arr: T[], seed: string) {
  const rng = seedrandom(seed);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Dealing sizes per your rules (no kitty)
export function cardsPerPlayer(players: number, deckCount: 1 | 2): number {
  if (players === 6 && deckCount === 1) return 8;            // 48 cards dealt
  if (players === 8 && deckCount === 1) return 6;            // 48 cards dealt
  if (players === 8 && deckCount === 2) return 12;           // 96 cards dealt
  if (players === 4 && deckCount === 1) return 12;           // 48 cards (optional support)
  // fallback: try to evenly divide ≤ total cards
  const total = buildDecksNoTwos(deckCount).length;
  return Math.floor(total / players);
}

// Deal in table order starting from startSeat
export function dealToPlayers(deck: Card[], players: number, startSeat: number, each: number) {
  const hands: Card[][] = Array.from({ length: players }, () => []);
  let p = startSeat;
  for (let i = 0; i < players * each; i++) {
    hands[p].push(deck[i]);
    p = (p + 1) % players;
  }
  return hands;
}

// Rank strength (Ace high)
const RANK_POWER: Record<Rank, number> = {
  A: 12, K: 11, Q: 10, J: 9, T: 8, 9: 7, 8: 6, 7: 5, 6: 4, 5: 3, 4: 2, 3: 1,
};

export type Play = { seat: number; card: Card; order: number }; // order = 0..(n-1) within trick

export function cardSuit(c: Card): Suit { return c.slice(-1) as Suit; }
export function cardRank(c: Card): Rank { return c.slice(0, c.length - 1) as Rank; }

// Decide trick winner per your rules:
// 1) If any trump is played -> highest trump wins.
// 2) Else -> highest of led suit wins.
// 3) Tie (identical card from multi-deck): the LATER play wins (higher 'order').
export function evaluateTrickWinner(plays: Play[], ledSuit: Suit, trumpSuit?: Suit | null): Play {
  let contenders = plays;

  const hasTrump = trumpSuit
    ? plays.some(p => cardSuit(p.card) === trumpSuit)
    : false;

  if (hasTrump && trumpSuit) {
    contenders = plays.filter(p => cardSuit(p.card) === trumpSuit);
  } else {
    contenders = plays.filter(p => cardSuit(p.card) === ledSuit);
  }

  // sort by rank strength asc, then by order asc, then pick LAST (so later identical wins)
  contenders.sort((a, b) => {
    const ra = RANK_POWER[cardRank(a.card)];
    const rb = RANK_POWER[cardRank(b.card)];
    if (ra !== rb) return ra - rb;
    // same exact card (with 2 decks), later order wins -> keep order asc, pick last
    if (cardSuit(a.card) !== cardSuit(b.card)) return 0; // different suits shouldn't be here
    return a.order - b.order;
  });

  return contenders[contenders.length - 1];
}

// Legal plays: if ledSuit set and player has that suit -> must play it.
export function legalPlays(hand: Card[], ledSuit?: Suit): Card[] {
  if (!ledSuit) return hand.slice();
  const ofLed = hand.filter(c => cardSuit(c) === ledSuit);
  return ofLed.length ? ofLed : hand.slice();
}
