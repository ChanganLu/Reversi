/**
 * evaluate.js — static position evaluation.
 *
 * Shared by the alpha-beta searcher (leaf scores) and by the MCTS engine (for
 * rollout cutoffs and for "obvious move" pruning). It works on bitboards and is
 * always expressed from the point of view of the player to move.
 *
 * Features, in rough order of importance for Reversi:
 *
 *   mobility      how many moves each side has — the dominant mid-game term
 *   stability     edge discs that can never be flipped again
 *   corners       permanent, and the X/C squares beside an empty corner are traps
 *   disc balance  almost meaningless early, decisive once the board fills up
 *   parity        who takes the last move, decisive in the final plies
 *
 * Weights are phase dependent: a per-empty-count table is precomputed once, so
 * evaluation costs one table lookup plus the feature arithmetic.
 */

import { countMoves, popcount32, popcount64 } from './bitboard.js';

/** Scores large enough to outrank any positional evaluation. */
export const WIN_SCORE = 500000;

/** Positional scores are clamped inside this bound. */
export const EVAL_LIMIT = 40000;

/**
 * Base weights, tuned by engine self-play (see tools/tune.mjs and the README).
 */
export const WEIGHTS = {
  /** Per extra legal move. */
  mobility: 190,
  /** Per extra corner. */
  corner: 1500,
  /** Per own disc sitting on an X/C square of an empty corner. */
  cornerAdjacent: -260,
  /** Per extra permanently stable disc. */
  stable: 150,
  /** Per extra disc: interpolated from early to late game. */
  discEarly: 3,
  discLate: 430,
  /** Parity bonus: interpolated from early to late game. */
  parityLate: 520,
};

/* ------------------------------------------------------------------ */
/* Phase table                                                         */
/* ------------------------------------------------------------------ */

/** Feature multipliers by phase, ordered from many empty squares to none. */
const PHASE_ANCHORS = [
  { empty: 60, mobility: 1.35, corner: 1.0, cornerAdjacent: 0.7, stable: 0.4, disc: 0.0, parity: 0.0 },
  { empty: 44, mobility: 1.2, corner: 1.0, cornerAdjacent: 0.9, stable: 0.6, disc: 0.0, parity: 0.0 },
  { empty: 30, mobility: 1.0, corner: 1.0, cornerAdjacent: 1.0, stable: 0.9, disc: 0.0, parity: 0.0 },
  { empty: 18, mobility: 0.7, corner: 0.9, cornerAdjacent: 1.0, stable: 1.0, disc: 0.1, parity: 0.3 },
  { empty: 10, mobility: 0.35, corner: 0.8, cornerAdjacent: 0.8, stable: 1.0, disc: 0.35, parity: 0.7 },
  { empty: 0, mobility: 0.1, corner: 0.6, cornerAdjacent: 0.4, stable: 0.8, disc: 1.0, parity: 1.0 },
];

const PHASE_KEYS = ['mobility', 'corner', 'cornerAdjacent', 'stable', 'disc', 'parity'];
const PHASE_COUNT = PHASE_KEYS.length;

/** Flattened per-empty-count multipliers: PHASE_TABLE[empty * PHASE_COUNT + key]. */
const PHASE_TABLE = new Float64Array(61 * PHASE_COUNT);
(() => {
  for (let empty = 0; empty <= 60; empty++) {
    let upper = PHASE_ANCHORS[0];
    let lower = PHASE_ANCHORS[PHASE_ANCHORS.length - 1];
    let t = 0;
    for (let i = 0; i < PHASE_ANCHORS.length - 1; i++) {
      const a = PHASE_ANCHORS[i];
      const b = PHASE_ANCHORS[i + 1];
      if (empty <= a.empty && empty >= b.empty) {
        upper = a;
        lower = b;
        const span = a.empty - b.empty;
        t = span === 0 ? 0 : (a.empty - empty) / span;
        break;
      }
    }
    const base = empty * PHASE_COUNT;
    for (let k = 0; k < PHASE_COUNT; k++) {
      const key = PHASE_KEYS[k];
      PHASE_TABLE[base + k] = upper[key] + (lower[key] - upper[key]) * t;
    }
  }
})();

/* ------------------------------------------------------------------ */
/* Stability                                                           */
/* ------------------------------------------------------------------ */

/**
 * For one edge (packed as two 8-bit masks: own discs, opponent discs) this
 * lookup returns the discs that can never be flipped again.
 *
 * A disc on an edge is stable exactly when the run of same-coloured discs
 * containing it reaches one of the two corners of that edge: a capture has to
 * be bounded by opponent discs on both sides, and a corner inside the run can
 * never provide such a bound.
 */
const EDGE_STABLE = new Uint8Array(1 << 16);
(() => {
  for (let own = 0; own < 256; own++) {
    for (let opp = 0; opp < 256; opp++) {
      if ((own & opp) !== 0) continue;
      let stable = 0;
      for (let i = 0; i < 8; i++) {
        if (((own >>> i) & 1) === 0) continue;
        const toLeft = (1 << (i + 1)) - 1;
        const toRight = (0xff << i) & 0xff;
        if ((own & toLeft) === toLeft || (own & toRight) === toRight) stable |= 1 << i;
      }
      EDGE_STABLE[(own << 8) | opp] = stable;
    }
  }
})();

/** Left column, top to bottom. */
const LEFT_COLUMN = [0, 8, 16, 24, 32, 40, 48, 56];
/** Right column, top to bottom. */
const RIGHT_COLUMN = [7, 15, 23, 31, 39, 47, 55, 63];

function gatherColumn(lo, hi, squares) {
  let mask = 0;
  for (let i = 0; i < 8; i++) {
    const sq = squares[i];
    const word = sq < 32 ? lo : hi;
    if (((word >>> (sq & 31)) & 1) === 1) mask |= 1 << i;
  }
  return mask;
}

function popcount8(mask) {
  return popcount32(mask & 0xff);
}

/**
 * Permanently stable disc counts for both sides.
 *
 * The top and bottom rows are counted in full; the columns then skip their
 * first and last square, because those are corners that the rows already
 * counted. (The table is symmetric, so the corners themselves can be taken
 * from either edge.)
 */
function stabilityCounts(ownLo, ownHi, oppLo, oppHi) {
  let ownStable = 0;
  let oppStable = 0;

  const ownEdges = [
    ownLo & 0xff, // top row
    (ownHi >>> 24) & 0xff, // bottom row
    gatherColumn(ownLo, ownHi, LEFT_COLUMN) & 0x7e, // left column without its corners
    gatherColumn(ownLo, ownHi, RIGHT_COLUMN) & 0x7e,
  ];
  const oppEdges = [
    oppLo & 0xff,
    (oppHi >>> 24) & 0xff,
    gatherColumn(oppLo, oppHi, LEFT_COLUMN) & 0x7e,
    gatherColumn(oppLo, oppHi, RIGHT_COLUMN) & 0x7e,
  ];

  for (let e = 0; e < 4; e++) {
    const own = ownEdges[e];
    const opp = oppEdges[e];
    ownStable += popcount8(EDGE_STABLE[(own << 8) | opp]);
    oppStable += popcount8(EDGE_STABLE[(opp << 8) | own]);
  }
  return { ownStable, oppStable };
}

/* ------------------------------------------------------------------ */
/* Corners                                                             */
/* ------------------------------------------------------------------ */

/** Bits of the a8/h8 corners (in the low word) and a1/h1 (in the high word). */
const CORNER_LO = (1 << 0) | (1 << 7);
const CORNER_HI = (1 << 24) | (1 << 31);

/**
 * The X and C squares of each corner, plus the corner bit that disarms them.
 * `word` selects the low or high half, `index` is the bit inside that word.
 */
const CORNER_TRAPS = [
  { word: 0, index: 0, lo: (1 << 9) | (1 << 1) | (1 << 8), hi: 0 }, // a8: b7, b8, a7
  { word: 0, index: 7, lo: (1 << 14) | (1 << 6) | (1 << 15), hi: 0 }, // h8: g7, g8, h7
  { word: 1, index: 24, lo: 0, hi: (1 << 17) | (1 << 25) | (1 << 16) }, // a1: b2, b1, a2
  { word: 1, index: 31, lo: 0, hi: (1 << 22) | (1 << 30) | (1 << 23) }, // h1: g2, g1, h2
];

/**
 * Counts the discs of one side that sit on an X/C square while the corner that
 * governs it is empty — a well-known liability.
 */
function cornerTrapCount(lo, hi) {
  let count = 0;
  for (let i = 0; i < 4; i++) {
    const trap = CORNER_TRAPS[i];
    const own = trap.word === 0 ? lo : hi;
    if (((own >>> trap.index) & 1) === 1) continue; // corner owned: no trap
    count += popcount32((lo & trap.lo) | (hi & trap.hi));
  }
  return count;
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Static evaluation from the point of view of the player to move.
 *
 * @param {number} ownLo @param {number} ownHi
 * @param {number} oppLo @param {number} oppHi
 * @param {number} [ownMoves] legal moves of the side to move, when the caller
 *   already knows it (pass -1 to compute)
 * @param {number} [oppMoves] legal moves of the opponent (pass -1 to compute)
 * @returns {number} score, positive when the side to move stands better
 */
export function evaluate(ownLo, ownHi, oppLo, oppHi, ownMoves = -1, oppMoves = -1) {
  const ownCount = popcount64(ownLo, ownHi);
  const oppCount = popcount64(oppLo, oppHi);
  // A legal game never has more than 60 empty squares; clamping keeps hand-made
  // test positions (and any future variant board) inside the phase table.
  const empty = Math.max(0, Math.min(60, 64 - ownCount - oppCount));

  const myMoves = ownMoves >= 0 ? ownMoves : countMoves(ownLo, ownHi, oppLo, oppHi);
  const theirMoves = oppMoves >= 0 ? oppMoves : countMoves(oppLo, oppHi, ownLo, ownHi);

  const base = empty * PHASE_COUNT;
  let score = WEIGHTS.mobility * PHASE_TABLE[base] * (myMoves - theirMoves);

  const ownCorners = popcount32(ownLo & CORNER_LO) + popcount32(ownHi & CORNER_HI);
  const oppCorners = popcount32(oppLo & CORNER_LO) + popcount32(oppHi & CORNER_HI);
  score += WEIGHTS.corner * PHASE_TABLE[base + 1] * (ownCorners - oppCorners);
  score += WEIGHTS.cornerAdjacent * PHASE_TABLE[base + 2] * (cornerTrapCount(ownLo, ownHi) - cornerTrapCount(oppLo, oppHi));

  const { ownStable, oppStable } = stabilityCounts(ownLo, ownHi, oppLo, oppHi);
  score += WEIGHTS.stable * PHASE_TABLE[base + 3] * (ownStable - oppStable);

  const discW = WEIGHTS.discEarly + (WEIGHTS.discLate - WEIGHTS.discEarly) * PHASE_TABLE[base + 4];
  score += discW * (ownCount - oppCount);

  if (empty > 0) {
    // With an odd number of empty squares the side to move also plays last.
    // This is a tempo term, so it deliberately breaks player symmetry: it is
    // always a bonus for whoever is to move.
    const parity = (empty & 1) === 1 ? 1 : -1;
    score += WEIGHTS.parityLate * PHASE_TABLE[base + 5] * parity;
  }

  if (score > EVAL_LIMIT) return EVAL_LIMIT;
  if (score < -EVAL_LIMIT) return -EVAL_LIMIT;
  return score;
}

/**
 * Terminal score from a disc balance: a win always outranks any positional
 * evaluation, and a bigger win outranks a smaller one.
 */
export function terminalScore(diff) {
  if (diff > 0) return WIN_SCORE + diff;
  if (diff < 0) return -WIN_SCORE + diff;
  return 0;
}

/** Exposed for tests and for the AI-information panel. */
export const internals = { stabilityCounts, cornerTrapCount, EDGE_STABLE, PHASE_TABLE, PHASE_KEYS, PHASE_COUNT };
