/**
 * evaluate.test.mjs — properties of the static evaluation.
 *
 * The evaluator is symmetric by construction; these tests pin that down so a
 * later weight tweak cannot silently break the sign conventions that the two
 * searchers rely on.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { BLACK, WHITE, applyMove as applyMoveArray, initialBoard, legalMoves } from '../js/game/rules.js';
import { encodePosition } from '../js/ai/bitboard.js';
import { EVAL_LIMIT, WIN_SCORE, evaluate, internals, terminalScore } from '../js/ai/evaluate.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pos = new Int32Array(4);

function randomPosition(seed, plies) {
  const rand = mulberry32(seed);
  const board = initialBoard();
  let me = BLACK;
  let passes = 0;
  for (let i = 0; i < plies; i++) {
    const moves = legalMoves(board, me);
    if (!moves.length) {
      if (++passes >= 2) break;
      me ^= 3;
      continue;
    }
    passes = 0;
    applyMoveArray(board, moves[Math.floor(rand() * moves.length)], me, me ^ 3);
    me ^= 3;
  }
  return { board, turn: me };
}

test('evaluation is antisymmetric between the two players (outside the parity phase)', () => {
  // The parity/tempo term is intentionally asymmetric: it always favours the
  // side to move. Up to 30 empty squares its weight is zero, so the evaluation
  // must be perfectly antisymmetric there.
  for (let seed = 1; seed <= 40; seed++) {
    for (const plies of [4, 12, 20, 28, 30]) {
      const { board, turn } = randomPosition(seed * 7919 + plies, plies);
      encodePosition(board, turn, pos);
      const a = evaluate(pos[0], pos[1], pos[2], pos[3]);
      const b = evaluate(pos[2], pos[3], pos[0], pos[1]);
      // `===` rather than strictEqual: 0 and -0 are the same score here.
      assert.ok(a === -b, `seed=${seed} plies=${plies}: ${a} vs ${b}`);
      assert.ok(Math.abs(a) <= EVAL_LIMIT);
    }
  }
});

test('the parity term only appears in the endgame and always favours the mover', () => {
  const { board, turn } = randomPosition(1234, 52); // 8 empty squares
  encodePosition(board, turn, pos);
  const evalMoverTurn = evaluate(pos[0], pos[1], pos[2], pos[3]);
  const evalOtherTurn = evaluate(pos[2], pos[3], pos[0], pos[1]);
  // With an even number of empties the side to move is the one that does *not*
  // take the last move, so the two evaluations are not exact negatives.
  assert.notEqual(evalMoverTurn, -evalOtherTurn);
  assert.ok(Math.abs(evalMoverTurn + evalOtherTurn) > 0);
});

test('the opening position evaluates to zero for both sides', () => {
  encodePosition(initialBoard(), BLACK, pos);
  assert.equal(evaluate(pos[0], pos[1], pos[2], pos[3]), 0);
});

test('taking a corner is worth much more than a corner-adjacent trap', () => {
  const withCorner = new Uint8Array(64);
  withCorner[0] = BLACK; // a8
  encodePosition(withCorner, BLACK, pos);
  const cornerScore = evaluate(pos[0], pos[1], pos[2], pos[3]);

  const trap = new Uint8Array(64);
  trap[9] = BLACK; // b7 (X square of an empty a8)
  encodePosition(trap, BLACK, pos);
  const trapScore = evaluate(pos[0], pos[1], pos[2], pos[3]);

  assert.ok(cornerScore > 0, 'owning a corner must be positive');
  assert.ok(trapScore < 0, 'occupying an X square next to an empty corner must be negative');
});

test('a corner disarms the trap of its own X/C squares', () => {
  const board = new Uint8Array(64);
  board[0] = BLACK; // a8 corner
  board[9] = BLACK; // b7 X square
  encodePosition(board, BLACK, pos);
  const scoreWithCorner = evaluate(pos[0], pos[1], pos[2], pos[3]);

  const board2 = new Uint8Array(64);
  board2[9] = BLACK; // only the X square
  encodePosition(board2, BLACK, pos);
  const scoreWithout = evaluate(pos[0], pos[1], pos[2], pos[3]);

  assert.ok(scoreWithCorner > scoreWithout);
});

test('edge stability: a run anchored at a corner is fully stable', () => {
  const board = new Uint8Array(64);
  // Black fills the whole top row including both corners.
  for (let sq = 0; sq < 8; sq++) board[sq] = BLACK;
  board[10] = WHITE;
  board[20] = WHITE;
  encodePosition(board, BLACK, pos);
  const { ownStable } = internals.stabilityCounts(pos[0], pos[1], pos[2], pos[3]);
  assert.ok(ownStable >= 8, `expected the full top row to be stable, got ${ownStable}`);
});

test('edge stability: an unanchored run is not stable', () => {
  const board = new Uint8Array(64);
  board[0] = WHITE;
  board[1] = BLACK;
  board[2] = BLACK;
  board[3] = BLACK;
  board[4] = WHITE;
  encodePosition(board, WHITE, pos);
  // From white's point of view the corners are not ours either, so nothing on
  // the edge is stable for white except the corner discs themselves.
  const { ownStable } = internals.stabilityCounts(pos[0], pos[1], pos[2], pos[3]);
  assert.equal(ownStable, 1); // only a8 (index 0) is anchored
});

test('mobility is seen as an advantage for whoever has more moves', () => {
  // Build an asymmetric position: black holds a corner-supported pocket while
  // white is boxed in.
  const board = new Uint8Array(64);
  board[0] = BLACK; // a8 corner, always good
  board[1] = WHITE;
  board[2] = BLACK;
  board[8] = WHITE;
  board[16] = WHITE;
  board[9] = WHITE;
  encodePosition(board, BLACK, pos);
  const blackScore = evaluate(pos[0], pos[1], pos[2], pos[3]);
  encodePosition(board, WHITE, pos);
  const whiteScore = evaluate(pos[0], pos[1], pos[2], pos[3]);
  assert.ok(blackScore > whiteScore, `black ${blackScore} should outscore white ${whiteScore}`);
});

test('terminal scores outrank any positional score', () => {
  assert.ok(terminalScore(1) > EVAL_LIMIT);
  assert.ok(terminalScore(-1) < -EVAL_LIMIT);
  assert.equal(terminalScore(0), 0);
  assert.ok(terminalScore(10) > terminalScore(1));
  assert.ok(terminalScore(-10) < terminalScore(-1));
  assert.equal(terminalScore(1), WIN_SCORE + 1);
});

test('disc balance dominates once the board is nearly full', () => {
  const board = new Uint8Array(64);
  for (let sq = 0; sq < 64; sq++) board[sq] = sq % 2 === 0 ? BLACK : WHITE;
  // Hand one disc to black so the balance differs by three.
  board[63] = BLACK;
  board[62] = BLACK;
  encodePosition(board, BLACK, pos);
  const score = evaluate(pos[0], pos[1], pos[2], pos[3]);
  assert.ok(score > 0);
});
