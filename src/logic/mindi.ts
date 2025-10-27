// src/logic/mindi.ts
import { Card, Suit, RANKS, cardSuit, cardRank, evaluateTrickWinner, legalPlays, buildDecksNoTwos, shuffle, cardsPerPlayer, Play } from './deck';

export type TeamLabel = 'A' | 'B' | 'C' | 'D';

export type TableMode =
  | '2v2'
  | '3v3'
  | '3teams_of_2'
  | '2v4'
  | '4teams_of_2';

export type DealPlan = {
  deckCount: 1 | 2;
  players: number;
  hiderSeat: number;        // the dealer who hides one random card
  leaderSeat: number;       // seat clockwise from hider
  trumpSuit: Suit;          // suit of the hidden card
  hands: { visible: Card[]; hidden?: Card | null }[]; // length = players
  seed: string;             // shuffle seed for audit
};

export function computeHiderAndLeader(prevHiderSeat: number | null, players: number, hostIsSeat0 = true) {
  // First hand: host hides (seat 0). Then rotates clockwise each hand.
  const hider = prevHiderSeat == null ? (hostIsSeat0 ? 0 : 0) : (prevHiderSeat + 1) % players;
  const leader = (hider + 1) % players;
  return { hider, leader };
}

// Build + deal per your rules (no 2s, specific cards per player, no kitty)
// 6p,1-deck => 8 each; 8p,1-deck => 6 each; 8p,2-deck => 12 each.
// Hider: one random card auto-hidden (trump suit = hidden card suit).
export function planDeal(players: number, deckCount: 1 | 2, hiderSeat: number, leaderSeat: number, seed: string): DealPlan {
  const deck = shuffle(buildDecksNoTwos(deckCount), seed);
  const each = cardsPerPlayer(players, deckCount);
  const raw = Array.from({ length: players }, () => [] as Card[]);
  // deal starting at leader seat (common pattern)
  let seat = leaderSeat;
  for (let i = 0; i < players * each; i++) {
    raw[seat].push(deck[i]);
    seat = (seat + 1) % players;
  }
  // auto-hide one random card from hider
  const hiderHand = raw[hiderSeat];
  const idx = Math.floor(Math.random() * hiderHand.length);
  const hidden = hiderHand.splice(idx, 1)[0];
  const trumpSuit = cardSuit(hidden);

  const hands = raw.map((arr, s) => ({
    visible: arr.slice().sort(sortBySuitRank),
    hidden: s === hiderSeat ? hidden : null,
  }));

  return { deckCount, players, hiderSeat, leaderSeat, trumpSuit, hands, seed };
}

function sortBySuitRank(a: Card, b: Card) {
  const sa = cardSuit(a), sb = cardSuit(b);
  if (sa !== sb) return SUIT_ORDER[sa] - SUIT_ORDER[sb];
  const ra = RANKS.indexOf(cardRank(a)), rb = RANKS.indexOf(cardRank(b));
  return ra - rb;
}
const SUIT_ORDER: Record<Suit, number> = { S: 0, H: 1, D: 2, C: 3 };

export type TrickState = {
  trickIndex: number;
  ledSuit?: Suit | null;
  plays: Play[];         // [{seat, card, order}]
  trumpRevealed: boolean;
  trumpRevealedBySeat?: number | null;
};

export function startTrick(): TrickState {
  return { trickIndex: 0, ledSuit: null, plays: [], trumpRevealed: false, trumpRevealedBySeat: null };
}

// Returns list of legal cards from hand given current led suit
export function legalToPlay(handVisible: Card[], ledSuit?: Suit | null) {
  return legalPlays(handVisible, ledSuit ?? undefined);
}

// If player is void in led suit and trump not revealed -> they MAY reveal, but must play a trump card on reveal.
// If they only have the hidden trump (hider) -> revealing consumes that hidden card.
// If they have other trumps -> they can choose which trump to play; hidden becomes visible for later.
export function canRevealTrump(handVisible: Card[], hidden: Card | null | undefined, ledSuit?: Suit | null, trumpRevealed?: boolean) {
  if (trumpRevealed) return false;
  if (!ledSuit) return false; // cannot reveal on first play unless you are void in the (non-existent) led suit; we require a led suit first
  const hasLed = handVisible.some(c => cardSuit(c) === ledSuit);
  if (hasLed) return false;
  // Otherwise, player is void in led suit; revealing is allowed (if they own a trump – which is guaranteed for hider via hidden)
  return true;
}

// From a completed trick, compute winner seat and number of tens taken in trick.
export function resolveTrick(plays: Play[], ledSuit: Suit, trumpSuit: Suit, players: number) {
  const win = evaluateTrickWinner(plays, ledSuit, undefinedIfUnrevealed(trumpSuit, plays));
  const tens = plays.filter(p => cardRank(p.card) === 'T').length;
  return { winnerSeat: win.seat, tensTaken: tens };
}

// Helper: if trump wasn't revealed in the trick, we treat trump as inactive.
function undefinedIfUnrevealed(trumpSuit: Suit, plays: Play[]): Suit | undefined {
  // The caller should track trump reveal across trick sequence; left here in case of standalone eval.
  return trumpSuit as Suit | undefined;
}

// Check end-of-hand: everyone played all visible cards (hider has hidden; becomes visible after reveal if not used immediately).
export function handFinished(hands: { visible: Card[]; hidden?: Card | null }[]) {
  return hands.every(h => h.visible.length === 0 && (!h.hidden || h.hidden === null));
}

// Reveal effect: if usingHidden = true -> consume hidden as the played card.
// If usingHidden = false and player plays another trump, move hidden into visible (unlock it) for future plays.
export function applyRevealOnHand(h: { visible: Card[]; hidden?: Card | null }, usingHidden: boolean, playedIfNotHidden?: Card) {
  if (usingHidden) {
    // hidden is being played now
    h.hidden = null;
    return;
  }
  // not using hidden -> ensure hidden becomes visible
  if (h.hidden) {
    h.visible.push(h.hidden);
    h.hidden = null;
    // ensure card order nice:
    h.visible.sort(sortBySuitRank);
  }
  // and playedIfNotHidden is removed by regular "play card" logic elsewhere
}
