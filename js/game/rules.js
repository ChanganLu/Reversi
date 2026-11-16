/**
 * rules.js — Reversi/Othello board primitives.
 *
 * This module is deliberately free of DOM or Node specifics so that it can be
 * shared by the UI, the Web Worker and the Node test-suite.
 *
 * Board layout
 * ------------
 * A board is a `Uint8Array(64)`. Index `sq = row * 8 + col`, row 0 is the top
 * row, col 0 is the left column. Values:
 *
 *     0 = empty,  1 = black (moves first),  2 = white
 *
 * Squares are addressed by that single index everywhere; helper functions
 * convert to/from the usual algebraic notation ("d3") used by the UI.
 *
 * Speed notes
 * -----------
 * Move generation dominates the cost of both engines, so the eight rays that
 * leave every square are precomputed once into flat typed arrays. Lookups then
 * cost a couple of array reads instead of repeated coordinate arithmetic.
 */

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

/** Sentinel return value for "this player must pass". */
export const PASS = -1;

export const BOARD_SIZE = 8;
export const SQUARE_COUNT = 64;

/** Row/col deltas, ordered so that opposite directions are d and d^1. */
export const DIRS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

export const CORNERS = [0, 7, 56, 63];

/** Squares diagonally touching a corner ("X squares"). */
export const X_SQUARES = [9, 14, 49, 54];

/** Squares orthogonally touching a corner ("C squares"). */
export const C_SQUARES = [1, 6, 8, 15, 48, 55, 57, 62];

/* ------------------------------------------------------------------ */
/* Precomputed geometry                                                */
/* ------------------------------------------------------------------ */

/** Flat list of every ray, one ray after another. */
export const RAY_SQUARES = new Uint8Array(SQUARE_COUNT * 8 * 7);
/**
 * Boundary table into RAY_SQUARES: the ray of (sq, d) occupies
 * RAY_START[sq * 8 + d] .. RAY_START[sq * 8 + d + 1]. Rays are stored
 * contiguously, so the hot loops only need this single table.
 */
export const RAY_START = new Int32Array(SQUARE_COUNT * 8 + 1);

/**
 * For every square a flat list of its (up to 8) neighbours.
 * Used by the heuristic rollouts and by the position evaluation.
 */
export const NEIGHBOR_OFFSET = new Int32Array(SQUARE_COUNT + 1);
export const NEIGHBOR_SQUARES = new Uint8Array(SQUARE_COUNT * 8);

{
  let cursor = 0;
  let neighborCursor = 0;
  for (let sq = 0; sq < SQUARE_COUNT; sq++) {
    const row = sq >> 3;
    const col = sq & 7;
    NEIGHBOR_OFFSET[sq] = neighborCursor;
    for (let d = 0; d < 8; d++) {
      const [dr, dc] = DIRS[d];
      const key = sq * 8 + d;
      RAY_START[key] = cursor;
      let length = 0;
      let r = row + dr;
      let c = col + dc;
      while (r >= 0 && r < 8 && c >= 0 && c < 8) {
        RAY_SQUARES[cursor + length] = (r << 3) | c;
        length++;
        r += dr;
        c += dc;
      }
      cursor += length;
    }
    // Neighbour list: only 64 * 8 bytes, used by the evaluator.
    let count = 0;
    for (let dRow = -1; dRow <= 1; dRow++) {
      for (let dCol = -1; dCol <= 1; dCol++) {
        if (dRow === 0 && dCol === 0) continue;
        const r = row + dRow;
        const c = col + dCol;
        if (r < 0 || r > 7 || c < 0 || c > 7) continue;
        NEIGHBOR_SQUARES[neighborCursor + count++] = (r << 3) | c;
      }
    }
    neighborCursor += count;
  }
  RAY_START[SQUARE_COUNT * 8] = cursor;
  NEIGHBOR_OFFSET[SQUARE_COUNT] = neighborCursor;
}

/* ------------------------------------------------------------------ */
/* Board construction and copying                                      */
/* ------------------------------------------------------------------ */

/** @returns {Uint8Array} an empty board. */
export function createBoard() {
  return new Uint8Array(SQUARE_COUNT);
}

/**
 * The standard Othello opening position.
 * Black: d5 (row 3, col 3) and e4 (row 4, col 4).
 * White: d4 (row 4, col 3) and e5 (row 3, col 4).
 */
export function initialBoard() {
  const board = new Uint8Array(SQUARE_COUNT);
  board[27] = BLACK; // d5
  board[36] = BLACK; // e4
  board[28] = WHITE; // d4
  board[35] = WHITE; // e5
  return board;
}

/** Fast copy of a board into `target` (both must be Uint8Array(64)). */
export function copyBoard(source, target) {
  target.set(source);
  return target;
}

/* ------------------------------------------------------------------ */
/* Core rule queries                                                   */
/* ------------------------------------------------------------------ */

/**
 * Is placing `me` on `sq` a legal move?
 * @param {Uint8Array} board
 * @param {number} sq target square (0..63)
 * @param {number} me player to move
 * @returns {boolean}
 */
export function isLegalMove(board, sq, me) {
  if (board[sq] !== EMPTY) return false;
  return isLegalMoveFast(board, sq, me, me ^ 3);
}

/**
 * Writes every legal move for `me` into `out` and returns how many there are.
 * `out` must hold at least 64 entries (a Uint8Array(64) is enough).
 *
 * This is the hottest function in the whole program: everything is hoisted and
 * inlined, and rays are traversed through the single contiguous RAY_START
 * table.
 */
export function generateMoves(board, me, out) {
  const opp = me ^ 3;
  const rays = RAY_SQUARES;
  const starts = RAY_START;
  let count = 0;
  for (let sq = 0; sq < SQUARE_COUNT; sq++) {
    if (board[sq] !== EMPTY) continue;
    const base = sq << 3;
    let legal = false;
    for (let d = 0; d < 8 && !legal; d++) {
      const key = base + d;
      const start = starts[key];
      const end = starts[key + 1];
      for (let i = start; i < end; i++) {
        const value = board[rays[i]];
        if (value === opp) continue;
        if (value === me && i > start) legal = true;
        break;
      }
    }
    if (legal) out[count++] = sq;
  }
  return count;
}

/** Same as isLegalMove but with the opponent already resolved. */
export function isLegalMoveFast(board, sq, me, opp) {
  if (board[sq] !== EMPTY) return false;
  const rays = RAY_SQUARES;
  const starts = RAY_START;
  const base = sq << 3;
  for (let d = 0; d < 8; d++) {
    const key = base + d;
    const start = starts[key];
    const end = starts[key + 1];
    for (let i = start; i < end; i++) {
      const value = board[rays[i]];
      if (value === opp) continue;
      if (value === me && i > start) return true;
      break;
    }
  }
  return false;
}

/** Convenience wrapper used by the UI. @returns {number[]} */
export function legalMoves(board, me) {
  const out = new Uint8Array(SQUARE_COUNT);
  const count = generateMoves(board, me, out);
  return Array.from(out.subarray(0, count));
}

/**
 * Places `me` on `sq`, flipping the captured discs.
 *
 * When `flipBuf` is provided the flipped square indices are appended to it
 * starting at `flipBase`, which lets callers undo the move exactly.
 *
 * @param {Uint8Array} board
 * @param {number} sq
 * @param {number} me
 * @param {number} opp
 * @param {Uint8Array|null} [flipBuf]
 * @param {number} [flipBase]
 * @returns {number} number of flipped discs (0 for an illegal move; the caller
 *   is expected to have validated the move with isLegalMove/generateMoves).
 */
export function applyMove(board, sq, me, opp, flipBuf = null, flipBase = 0) {
  const rays = RAY_SQUARES;
  const starts = RAY_START;
  const base = sq << 3;
  let total = 0;
  for (let d = 0; d < 8; d++) {
    const key = base + d;
    const start = starts[key];
    const end = starts[key + 1];
    let count = 0;
    let closed = false;
    for (let i = start; i < end; i++) {
      const value = board[rays[i]];
      if (value === opp) {
        count++;
        continue;
      }
      // The run only flips when it is closed by one of our own discs; an empty
      // square or the board edge kills the direction.
      closed = value === me && count > 0;
      break;
    }
    if (!closed) continue;
    for (let i = 0; i < count; i++) {
      const target = rays[start + i];
      board[target] = me;
      if (flipBuf !== null) flipBuf[flipBase + total + i] = target;
    }
    total += count;
  }
  board[sq] = me;
  return total;
}

/**
 * Reverts a move previously played with applyMove(..., flipBuf, flipBase).
 * The flipped squares are restored to `opp` and `sq` becomes empty again.
 */
export function undoMove(board, sq, me, opp, flipBuf, flipBase, flipCount) {
  board[sq] = EMPTY;
  for (let i = 0; i < flipCount; i++) {
    board[flipBuf[flipBase + i]] = opp;
  }
  void me;
}

/** @returns {{black:number, white:number, empty:number}} */
export function countDiscs(board) {
  let black = 0;
  let white = 0;
  for (let sq = 0; sq < SQUARE_COUNT; sq++) {
    const value = board[sq];
    if (value === BLACK) black++;
    else if (value === WHITE) white++;
  }
  return { black, white, empty: SQUARE_COUNT - black - white };
}

/** Number of discs of one colour. */
export function countColor(board, color) {
  let count = 0;
  for (let sq = 0; sq < SQUARE_COUNT; sq++) {
    if (board[sq] === color) count++;
  }
  return count;
}

/**
 * Resolves the position after `me` played: who moves next, and whether the
 * game is over. Passing is folded in — if the opponent has no legal move but
 * the mover does, the mover plays again.
 *
 * @returns {{next:number, over:boolean}}
 */
export function nextPlayerAfter(board, mover, scratch) {
  const opponent = mover ^ 3;
  if (generateMoves(board, opponent, scratch) > 0) return { next: opponent, over: false };
  if (generateMoves(board, mover, scratch) > 0) return { next: mover, over: false };
  return { next: opponent, over: true };
}

/**
 * True when neither side can move (game over).
 */
export function isGameOver(board, scratch) {
  return generateMoves(board, BLACK, scratch) === 0 && generateMoves(board, WHITE, scratch) === 0;
}

/**
 * Final result of a finished position, signed for `color`:
 * positive = `color` wins by that many discs.
 */
export function discDifference(board) {
  const { black, white } = countDiscs(board);
  return black - white;
}

/* ------------------------------------------------------------------ */
/* Notation                                                            */
/* ------------------------------------------------------------------ */

const FILES = 'abcdefgh';

/** "d3"-style name for a square index. */
export function toNotation(sq) {
  if (sq < 0 || sq > 63) return '--';
  return FILES[sq & 7] + (8 - (sq >> 3));
}

/** Parses "d3" (case-insensitive). @returns {number} square or -1. */
export function fromNotation(text) {
  if (typeof text !== 'string' || text.length < 2) return -1;
  const col = FILES.indexOf(text[0].toLowerCase());
  const rank = Number(text[1]);
  if (col < 0 || !Number.isInteger(rank) || rank < 1 || rank > 8) return -1;
  return (8 - rank) * 8 + col;
}
