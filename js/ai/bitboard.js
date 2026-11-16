/**
 * bitboard.js — 64-bit board arithmetic for the search engines.
 *
 * A Reversi position is two 64-bit masks (own discs / opponent discs). Since
 * JavaScript bitwise operators are 32-bit, every mask is stored as a pair of
 * int32 words: board squares 0..31 live in word 0, squares 32..63 in word 1.
 *
 * Convention
 * ----------
 * A position occupies four consecutive int32 values in an Int32Array:
 *
 *     [ ownLo, ownHi, oppLo, oppHi ]
 *
 * and is always expressed **relative to the player to move** ("own"). Callers
 * therefore never reason about black and white: `applyMove` returns the
 * successor already from the other player's point of view.
 *
 * Everything here is cross-validated against the array implementation in
 * `tests/bitboard.test.mjs` over tens of thousands of random positions.
 */

export const OWN_LO = 0;
export const OWN_HI = 1;
export const OPP_LO = 2;
export const OPP_HI = 3;

/** Number of int32 values in an encoded position. */
export const POS_SIZE = 4;

/* ------------------------------------------------------------------ */
/* Small bit utilities                                                 */
/* ------------------------------------------------------------------ */

const POPCOUNT16 = new Int8Array(1 << 16);
for (let i = 1; i < 1 << 16; i++) POPCOUNT16[i] = POPCOUNT16[i >> 1] + (i & 1);

/** Population count of a 32-bit word. */
export function popcount32(x) {
  return POPCOUNT16[x & 0xffff] + POPCOUNT16[(x >>> 16) & 0xffff];
}

/** Number of set bits in a (lo, hi) mask pair. */
export function popcount64(lo, hi) {
  return (
    POPCOUNT16[lo & 0xffff] +
    POPCOUNT16[(lo >>> 16) & 0xffff] +
    POPCOUNT16[hi & 0xffff] +
    POPCOUNT16[(hi >>> 16) & 0xffff]
  );
}

/** Index (0..31) of the lowest set bit of a non-zero 32-bit word. */
export function bitIndex(word) {
  return 31 - Math.clz32(word & -word);
}

/* ------------------------------------------------------------------ */
/* Direction masks                                                     */
/* ------------------------------------------------------------------ */

function buildMask(predicate) {
  let lo = 0;
  let hi = 0;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      if (!predicate(row, col)) continue;
      const sq = row * 8 + col;
      if (sq < 32) lo |= 1 << sq;
      else hi |= 1 << (sq - 32);
    }
  }
  return [lo, hi];
}

const NOT_COL0 = buildMask((row, col) => col !== 0);
const NOT_COL7 = buildMask((row, col) => col !== 7);
const NOT_ROW0 = buildMask((row) => row !== 0);
const NOT_ROW7 = buildMask((row) => row !== 7);

const and2 = (a, b) => [a[0] & b[0], a[1] & b[1]];

const SEMI_NE = and2(NOT_ROW0, NOT_COL7);
const SEMI_NW = and2(NOT_ROW0, NOT_COL0);
const SEMI_SE = and2(NOT_ROW7, NOT_COL7);
const SEMI_SW = and2(NOT_ROW7, NOT_COL0);

/**
 * The eight directions as (index step, movable-source mask).
 *
 * The mask removes the squares from which one step of that direction would
 * leave the board. It must be applied to the operand of *every* step: without
 * it, a horizontal step off the right edge wraps into the next row and
 * fabricates captures that do not exist.
 */
const DIR_STEP = new Int32Array([-9, -8, -7, -1, 1, 7, 8, 9]);
const DIR_MASK_LO = new Int32Array([
  SEMI_NW[0], NOT_ROW0[0], SEMI_NE[0], NOT_COL0[0],
  NOT_COL7[0], SEMI_SW[0], NOT_ROW7[0], SEMI_SE[0],
]);
const DIR_MASK_HI = new Int32Array([
  SEMI_NW[1], NOT_ROW0[1], SEMI_NE[1], NOT_COL0[1],
  NOT_COL7[1], SEMI_SW[1], NOT_ROW7[1], SEMI_SE[1],
]);

/* ------------------------------------------------------------------ */
/* Pair shifting                                                       */
/* ------------------------------------------------------------------ */
// A shift produces two words; JavaScript cannot return pairs without
// allocating, so results are published through module scratch. The functions
// are only used in straight-line code, never across a callback boundary.

let outLo = 0;
let outHi = 0;

/** Shifts the (lo, hi) pair towards higher indices by k bits (0 < k < 32). */
function shiftUpPair(lo, hi, k) {
  outLo = lo << k;
  outHi = (hi << k) | (lo >>> (32 - k));
}

/** Shifts the (lo, hi) pair towards lower indices by k bits (0 < k < 32). */
function shiftDownPair(lo, hi, k) {
  outHi = hi >>> k;
  outLo = (lo >>> k) | (hi << (32 - k));
}

function shiftPair(lo, hi, step) {
  if (step > 0) shiftUpPair(lo, hi, step);
  else shiftDownPair(lo, hi, -step);
}

/* ------------------------------------------------------------------ */
/* Conversion helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Encodes a coloured array board into a relative position.
 * @param {Uint8Array} board 64 entries: 0 empty, 1 black, 2 white
 * @param {number} turn player to move (1 = black, 2 = white)
 * @param {Int32Array} out destination with room for `offset + 4` values
 */
export function encodePosition(board, turn, out, offset = 0) {
  let ownLo = 0;
  let ownHi = 0;
  let oppLo = 0;
  let oppHi = 0;
  for (let sq = 0; sq < 64; sq++) {
    const value = board[sq];
    if (value === 0) continue;
    const bit = sq < 32 ? 1 << sq : 1 << (sq - 32);
    if (value === turn) {
      if (sq < 32) ownLo |= bit;
      else ownHi |= bit;
    } else if (sq < 32) oppLo |= bit;
    else oppHi |= bit;
  }
  out[offset + OWN_LO] = ownLo;
  out[offset + OWN_HI] = ownHi;
  out[offset + OPP_LO] = oppLo;
  out[offset + OPP_HI] = oppHi;
  return out;
}

/** Copies a position (4 ints) between buffers. */
export function copyPosition(source, sourceOffset, target, targetOffset) {
  target[targetOffset] = source[sourceOffset];
  target[targetOffset + 1] = source[sourceOffset + 1];
  target[targetOffset + 2] = source[sourceOffset + 2];
  target[targetOffset + 3] = source[sourceOffset + 3];
}

/** Swaps the own/opponent halves in place (used to model a forced pass). */
export function swapSides(buffer, offset) {
  const lo = buffer[offset];
  const hi = buffer[offset + 1];
  buffer[offset] = buffer[offset + 2];
  buffer[offset + 1] = buffer[offset + 3];
  buffer[offset + 2] = lo;
  buffer[offset + 3] = hi;
}

/* ------------------------------------------------------------------ */
/* Move generation                                                     */
/* ------------------------------------------------------------------ */

// Scratch results of the internal generators, so the helpers below can reuse
// the same computation without allocating.
let maskLo = 0;
let maskHi = 0;

/**
 * Computes the legal-move mask of the player to move into (maskLo, maskHi).
 *
 * The scan is the classic "walk our discs towards the opponent, then step once
 * more into an empty square", performed in parallel for all 64 squares.
 */
function computeMoveMask(ownLo, ownHi, oppLo, oppHi) {
  const emptyLo = ~(ownLo | oppLo);
  const emptyHi = ~(ownHi | oppHi);
  let resultLo = 0;
  let resultHi = 0;
  for (let d = 0; d < 8; d++) {
    const step = DIR_STEP[d];
    const mLo = DIR_MASK_LO[d];
    const mHi = DIR_MASK_HI[d];
    // Step one of our discs along d; only the ones that stay on the board may
    // start a capture run.
    shiftPair(ownLo & mLo, ownHi & mHi, step);
    let tLo = outLo & oppLo;
    let tHi = outHi & oppHi;
    if ((tLo | tHi) === 0) continue;
    // Extend the run through opponent discs; chains are short, so bail early.
    for (let k = 0; k < 5; k++) {
      shiftPair(tLo & mLo, tHi & mHi, step);
      const nLo = outLo & oppLo;
      const nHi = outHi & oppHi;
      if ((nLo | nHi) === 0) break;
      tLo |= nLo;
      tHi |= nHi;
    }
    // One more step lands on the empty squares that close the capture.
    shiftPair(tLo & mLo, tHi & mHi, step);
    resultLo |= outLo & emptyLo;
    resultHi |= outHi & emptyHi;
  }
  maskLo = resultLo;
  maskHi = resultHi;
  return popcount64(resultLo, resultHi);
}

/**
 * Writes the legal-move bit mask into `out` (2 ints) and returns the number of
 * legal moves.
 */
export function moveMask(ownLo, ownHi, oppLo, oppHi, out) {
  const count = computeMoveMask(ownLo, ownHi, oppLo, oppHi);
  out[0] = maskLo;
  out[1] = maskHi;
  return count;
}

/** Number of legal moves for the player to move. */
export function countMoves(ownLo, ownHi, oppLo, oppHi) {
  return computeMoveMask(ownLo, ownHi, oppLo, oppHi);
}

/** True when the player to move has at least one legal move. */
export function hasMove(ownLo, ownHi, oppLo, oppHi) {
  return computeMoveMask(ownLo, ownHi, oppLo, oppHi) > 0;
}

/** True when `sq` is a legal move for the player to move. */
export function canPlay(ownLo, ownHi, oppLo, oppHi, sq) {
  computeMoveMask(ownLo, ownHi, oppLo, oppHi);
  return sq < 32 ? ((maskLo >>> sq) & 1) === 1 : ((maskHi >>> (sq - 32)) & 1) === 1;
}

/* ------------------------------------------------------------------ */
/* Move application                                                    */
/* ------------------------------------------------------------------ */

/**
 * Plays `sq` and writes the successor into `out` at `outOffset`.
 *
 * The successor is expressed from the *next* player's point of view — `own`
 * holds the discs of the opponent of the mover — so it can be searched or
 * played immediately. The caller must have validated the move.
 */
export function applyMove(ownLo, ownHi, oppLo, oppHi, sq, out, outOffset = 0) {
  const bit = sq < 32 ? 1 << sq : 1 << (sq - 32);
  const moveLo = sq < 32 ? bit : 0;
  const moveHi = sq < 32 ? 0 : bit;

  let flipsLo = 0;
  let flipsHi = 0;
  for (let d = 0; d < 8; d++) {
    const step = DIR_STEP[d];
    const mLo = DIR_MASK_LO[d];
    const mHi = DIR_MASK_HI[d];
    shiftPair(moveLo & mLo, moveHi & mHi, step);
    let tLo = outLo & oppLo;
    let tHi = outHi & oppHi;
    if ((tLo | tHi) === 0) continue;
    for (let k = 0; k < 5; k++) {
      shiftPair(tLo & mLo, tHi & mHi, step);
      const nLo = outLo & oppLo;
      const nHi = outHi & oppHi;
      if ((nLo | nHi) === 0) break;
      tLo |= nLo;
      tHi |= nHi;
    }
    // The run flips only when it is closed by one of our own discs.
    shiftPair(tLo & mLo, tHi & mHi, step);
    if (((outLo & ownLo) | (outHi & ownHi)) !== 0) {
      flipsLo |= tLo;
      flipsHi |= tHi;
    }
  }

  const newOwnLo = ownLo | moveLo | flipsLo;
  const newOwnHi = ownHi | moveHi | flipsHi;
  // Successor from the opponent's point of view: they lose the flipped discs.
  out[outOffset + OWN_LO] = oppLo & ~flipsLo;
  out[outOffset + OWN_HI] = oppHi & ~flipsHi;
  out[outOffset + OPP_LO] = newOwnLo;
  out[outOffset + OPP_HI] = newOwnHi;
  return out;
}

/**
 * Models a forced pass on a position whose side to move cannot play: the
 * successor of nothing but a side swap, ready to be played from.
 */
export function afterPass(ownLo, ownHi, oppLo, oppHi, out, outOffset = 0) {
  out[outOffset + OWN_LO] = oppLo;
  out[outOffset + OWN_HI] = oppHi;
  out[outOffset + OPP_LO] = ownLo;
  out[outOffset + OPP_HI] = ownHi;
  return out;
}

/** Disc balance (own minus opponent) of the player to move. */
export function discBalance(ownLo, ownHi, oppLo, oppHi) {
  return popcount64(ownLo, ownHi) - popcount64(oppLo, oppHi);
}

/** True when neither player can move. */
export function isTerminal(ownLo, ownHi, oppLo, oppHi) {
  if (computeMoveMask(ownLo, ownHi, oppLo, oppHi) > 0) return false;
  return computeMoveMask(oppLo, oppHi, ownLo, ownHi) === 0;
}

/* ------------------------------------------------------------------ */
/* Debug helper                                                        */
/* ------------------------------------------------------------------ */

/** Renders a position as an 8x8 ASCII diagram (X = to move, O = opponent). */
export function positionToString(buffer, offset = 0) {
  const ownLo = buffer[offset + OWN_LO];
  const ownHi = buffer[offset + OWN_HI];
  const oppLo = buffer[offset + OPP_LO];
  const oppHi = buffer[offset + OPP_HI];
  const rows = [];
  for (let row = 0; row < 8; row++) {
    let line = '';
    for (let col = 0; col < 8; col++) {
      const sq = row * 8 + col;
      const bit = sq < 32 ? 1 << sq : 1 << (sq - 32);
      const isOwn = ((sq < 32 ? ownLo : ownHi) & bit) !== 0;
      const isOpp = ((sq < 32 ? oppLo : oppHi) & bit) !== 0;
      line += isOwn ? 'X' : isOpp ? 'O' : '.';
    }
    rows.push(line);
  }
  return rows.join('\n');
}
