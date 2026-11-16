/**
 * bitboard.test.mjs — the engine's 64-bit layer must agree with rules.js.
 *
 * Every primitive is checked against the array implementation over many
 * randomised positions, so an error in the shift/mask arithmetic can never
 * reach the search.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BLACK,
  EMPTY,
  WHITE,
  applyMove as applyMoveArray,
  countDiscs,
  generateMoves,
  initialBoard,
  legalMoves,
} from '../js/game/rules.js';
import {
  POS_SIZE,
  applyMove,
  afterPass,
  bitIndex,
  canPlay,
  countMoves,
  discBalance,
  encodePosition,
  hasMove,
  isTerminal,
  moveMask,
  popcount32,
  popcount64,
  positionToString,
  swapSides,
} from '../js/ai/bitboard.js';

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

const maskBuffer = new Int32Array(2);
const pos = new Int32Array(POS_SIZE);
const nextPos = new Int32Array(POS_SIZE);

function maskToSquares(lo, hi) {
  const squares = [];
  for (let sq = 0; sq < 32; sq++) if (((lo >>> sq) & 1) === 1) squares.push(sq);
  for (let sq = 0; sq < 32; sq++) if (((hi >>> sq) & 1) === 1) squares.push(sq + 32);
  return squares.sort((a, b) => a - b);
}

/* ---------------------------------------------------------------- */

test('popcount helpers', () => {
  assert.equal(popcount32(0), 0);
  assert.equal(popcount32(0xffffffff), 32);
  assert.equal(popcount32(0b1011), 3);
  assert.equal(popcount64(0xffffffff, 0xffffffff), 64);
  assert.equal(popcount64(1, 1 << 31), 2);
  assert.equal(bitIndex(1), 0);
  assert.equal(bitIndex(1 << 31), 31);
  assert.equal(bitIndex(0x8000000), 27);
});

test('opening position encodes and generates the four opening moves', () => {
  const board = initialBoard();
  encodePosition(board, BLACK, pos);
  assert.equal(moveMask(pos[0], pos[1], pos[2], pos[3], maskBuffer), 4);
  const squares = maskToSquares(maskBuffer[0], maskBuffer[1]);
  assert.deepEqual(squares, legalMoves(board, BLACK).sort((a, b) => a - b));
  assert.equal(countMoves(pos[0], pos[1], pos[2], pos[3]), 4);
  assert.equal(hasMove(pos[0], pos[1], pos[2], pos[3]), true);
  for (const sq of squares) assert.equal(canPlay(pos[0], pos[1], pos[2], pos[3], sq), true);
  assert.equal(canPlay(pos[0], pos[1], pos[2], pos[3], 0), false);

  const diagram = positionToString(pos);
  assert.equal(diagram.split('\n').length, 8);
  assert.match(diagram, /^........$/m);
});

test('move generation matches rules.js on random positions', () => {
  for (let seed = 1; seed <= 120; seed++) {
    for (const plies of [0, 3, 9, 17, 28, 39, 50, 58]) {
      const { board, turn } = randomPosition(seed * 7919 + plies, plies);
      for (const me of [BLACK, WHITE]) {
        encodePosition(board, me, pos);
        const expected = legalMoves(board, me).sort((a, b) => a - b);
        const count = moveMask(pos[0], pos[1], pos[2], pos[3], maskBuffer);
        const actual = maskToSquares(maskBuffer[0], maskBuffer[1]);
        assert.deepEqual(actual, expected, `seed=${seed} plies=${plies} me=${me}`);
        assert.equal(count, expected.length);
        assert.equal(countMoves(pos[0], pos[1], pos[2], pos[3]), expected.length);
        assert.equal(hasMove(pos[0], pos[1], pos[2], pos[3]), expected.length > 0);
        for (let sq = 0; sq < 64; sq++) {
          assert.equal(
            canPlay(pos[0], pos[1], pos[2], pos[3], sq),
            expected.includes(sq),
            `canPlay mismatch seed=${seed} plies=${plies} sq=${sq}`,
          );
        }
        void turn;
      }
    }
  }
});

test('applied moves match the array implementation disc for disc', () => {
  for (let seed = 1; seed <= 80; seed++) {
    for (const plies of [2, 11, 23, 34, 46]) {
      const { board, turn } = randomPosition(seed * 104729 + plies, plies);
      const moves = legalMoves(board, turn);
      for (const sq of moves) {
        encodePosition(board, turn, pos);
        // The successor is already expressed for the next player.
        applyMove(pos[0], pos[1], pos[2], pos[3], sq, nextPos);

        const expected = Uint8Array.from(board);
        applyMoveArray(expected, sq, turn, turn ^ 3);
        const check = new Int32Array(POS_SIZE);
        encodePosition(expected, turn ^ 3, check);
        assert.deepEqual(Array.from(nextPos), Array.from(check), `seed=${seed} sq=${sq}`);

        const counts = countDiscs(expected);
        const mover = turn ^ 3;
        assert.equal(
          discBalance(nextPos[0], nextPos[1], nextPos[2], nextPos[3]),
          mover === BLACK ? counts.black - counts.white : counts.white - counts.black,
        );
      }
    }
  }
});

test('the successor is expressed from the next player perspective', () => {
  const { board, turn } = randomPosition(4242, 12);
  const sq = legalMoves(board, turn)[0];
  encodePosition(board, turn, pos);
  applyMove(pos[0], pos[1], pos[2], pos[3], sq, nextPos);
  const moverBefore = popcount64(pos[0], pos[1]);
  const otherBefore = popcount64(pos[2], pos[3]);
  // nextPos.OWN is the other player (they lost the flipped discs).
  const otherAfter = popcount64(nextPos[0], nextPos[1]);
  // nextPos.OPP is the mover (their new disc plus every captured disc).
  const moverAfter = popcount64(nextPos[2], nextPos[3]);
  assert.ok(otherAfter < otherBefore);
  assert.ok(moverAfter > moverBefore);
  assert.equal(moverAfter + otherAfter, moverBefore + otherBefore + 1);
});

test('afterPass swaps the sides', () => {
  const { board, turn } = randomPosition(777, 15);
  encodePosition(board, turn, pos);
  afterPass(pos[0], pos[1], pos[2], pos[3], nextPos);
  assert.equal(nextPos[0], pos[2]);
  assert.equal(nextPos[1], pos[3]);
  assert.equal(nextPos[2], pos[0]);
  assert.equal(nextPos[3], pos[1]);
});

test('swapSides is its own inverse', () => {
  const { board, turn } = randomPosition(31337, 18);
  encodePosition(board, turn, pos);
  const copy = Int32Array.from(pos);
  swapSides(pos, 0);
  swapSides(pos, 0);
  assert.deepEqual(Array.from(pos), Array.from(copy));
});

test('terminal detection agrees with rules.js on finished games', () => {
  const rand = mulberry32(2024);
  let finished = 0;
  for (let game = 0; game < 30; game++) {
    const board = initialBoard();
    let me = BLACK;
    let guard = 0;
    while (guard++ < 200) {
      const moves = legalMoves(board, me);
      if (!moves.length) {
        // Would the other side have a move?
        if (legalMoves(board, me ^ 3).length === 0) break;
        me ^= 3;
        continue;
      }
      applyMoveArray(board, moves[Math.floor(rand() * moves.length)], me, me ^ 3);
      me ^= 3;
    }
    encodePosition(board, me, pos);
    assert.equal(isTerminal(pos[0], pos[1], pos[2], pos[3]), true);
    assert.equal(hasMove(pos[0], pos[1], pos[2], pos[3]), false);
    finished++;
  }
  assert.equal(finished, 30);
});

test('a single forced pass is not mistaken for the end of the game', () => {
  // Search random games for a position where the side to move is blocked but
  // the opponent can still play: that is a pass, not a terminal position.
  const rand = mulberry32(20240815);
  let found = 0;
  for (let game = 0; game < 200 && found < 3; game++) {
    const board = initialBoard();
    let me = BLACK;
    for (let guard = 0; guard < 200; guard++) {
      const moves = legalMoves(board, me);
      if (!moves.length) {
        if (legalMoves(board, me ^ 3).length === 0) break; // real game over
        encodePosition(board, me, pos);
        assert.equal(hasMove(pos[0], pos[1], pos[2], pos[3]), false);
        assert.equal(isTerminal(pos[0], pos[1], pos[2], pos[3]), false);
        found++;
        break;
      }
      applyMoveArray(board, moves[Math.floor(rand() * moves.length)], me, me ^ 3);
      me ^= 3;
    }
  }
  assert.ok(found > 0, 'no forced pass occurred in the sampled games');
  void EMPTY;
});
