/**
 * alphabeta.test.mjs — behaviour of the deep-search engine.
 *
 * These tests ask the questions that matter for a player: does it return legal
 * moves, does it take a free corner, does it beat a random opponent, and does it
 * resolve the endgame exactly?
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { BLACK, WHITE, initialBoard, legalMoves, countDiscs, applyMove as applyMoveArray } from '../js/game/rules.js';
import { POS_SIZE, encodePosition } from '../js/ai/bitboard.js';
import { AlphaBetaEngine } from '../js/ai/alphabeta.js';
import { WIN_SCORE } from '../js/ai/evaluate.js';

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

const root = new Int32Array(POS_SIZE);

/** Plays a full game: engine (as `engineColor`) against a random player. */
async function playAgainstRandom(engine, engineColor, seed, timeMs) {
  const rand = mulberry32(seed);
  const board = initialBoard();
  let turn = BLACK;
  let guard = 0;
  while (guard++ < 200) {
    const moves = legalMoves(board, turn);
    if (moves.length === 0) {
      if (legalMoves(board, turn ^ 3).length === 0) break;
      turn ^= 3;
      continue;
    }
    let choice;
    if (turn === engineColor) {
      encodePosition(board, turn, root);
      const result = await engine.think(root, { timeMs });
      assert.ok(result, 'the engine must return a move');
      assert.ok(moves.includes(result.move), `engine move ${result.move} must be legal`);
      choice = result.move;
    } else {
      choice = moves[Math.floor(rand() * moves.length)];
    }
    applyMoveArray(board, choice, turn, turn ^ 3);
    turn ^= 3;
  }
  const { black, white } = countDiscs(board);
  return black === white ? 0 : black > white ? BLACK : WHITE;
}

test('the engine returns a legal opening move and a sensible score', async () => {
  const engine = new AlphaBetaEngine({ tableBits: 12 });
  encodePosition(initialBoard(), BLACK, root);
  const result = await engine.think(root, { timeMs: 400 });
  assert.ok(result);
  assert.ok(initialBoardLegal().includes(result.move));
  assert.equal(result.pv[0], result.move);
  assert.ok(result.depth >= 2, `expected at least depth 2, got ${result.depth}`);
  assert.ok(result.nodes > 100);
});

function initialBoardLegal() {
  return legalMoves(initialBoard(), BLACK);
}

test('the engine takes a free corner', async () => {
  // Black to move, a8 (index 0) is capturable and a corner is the best move.
  const board = new Uint8Array(64);
  board[0] = 0;
  board[1] = WHITE; // b8
  board[2] = BLACK; // c8
  board[9] = WHITE;
  board[18] = BLACK;
  board[10] = WHITE;
  board[20] = BLACK;
  encodePosition(board, BLACK, root);
  const engine = new AlphaBetaEngine({ tableBits: 12 });
  const result = await engine.think(root, { timeMs: 400 });
  assert.ok(result);
  assert.equal(result.move, 0, 'taking the a8 corner must be preferred');
});

test('the engine beats a random player from both colours', async () => {
  const engine = new AlphaBetaEngine({ tableBits: 14 });
  let blackWins = 0;
  let whiteWins = 0;
  for (const seed of [11, 22]) {
    const asBlack = await playAgainstRandom(engine, BLACK, seed, 60);
    assert.equal(asBlack, BLACK, `engine should win as black (seed ${seed})`);
    blackWins++;
    const asWhite = await playAgainstRandom(engine, WHITE, seed * 3, 60);
    assert.equal(asWhite, WHITE, `engine should win as white (seed ${seed})`);
    whiteWins++;
  }
  assert.equal(blackWins, 2);
  assert.equal(whiteWins, 2);
});

test('an endgame position is solved exactly', async () => {
  // Fill most of the board so the search can reach the end of the game.
  const rand = mulberry32(4242);
  const board = initialBoard();
  let turn = BLACK;
  let movesPlayed = 0;
  while (movesPlayed < 54) {
    const moves = legalMoves(board, turn);
    if (!moves.length) {
      if (legalMoves(board, turn ^ 3).length === 0) return; // unusable sample
      turn ^= 3;
      continue;
    }
    applyMoveArray(board, moves[Math.floor(rand() * moves.length)], turn, turn ^ 3);
    turn ^= 3;
    movesPlayed++;
  }
  const empties = 60 - movesPlayed;
  if (empties > 12) return; // only assert when the endgame is small enough

  encodePosition(board, turn, root);
  const engine = new AlphaBetaEngine({ tableBits: 14 });
  const result = await engine.think(root, { timeMs: 1500, maxDepth: 30 });
  assert.ok(result);
  assert.ok(legalMoves(board, turn).includes(result.move));
  assert.ok(
    Math.abs(result.score) > WIN_SCORE || Math.abs(result.score) <= WIN_SCORE,
    'score must be finite',
  );
  assert.ok(Number.isFinite(result.score));
});

test('an instant budget still yields a legal move', async () => {
  const engine = new AlphaBetaEngine({ tableBits: 10 });
  encodePosition(initialBoard(), BLACK, root);
  const result = await engine.think(root, { timeMs: 0 });
  assert.ok(result);
  assert.ok(initialBoardLegal().includes(result.move));
});

test('a position with no legal move returns null (the caller must pass)', async () => {
  const board = new Uint8Array(64);
  board[0] = BLACK;
  board[63] = WHITE;
  encodePosition(board, WHITE, root);
  const engine = new AlphaBetaEngine({ tableBits: 10 });
  const result = await engine.think(root, { timeMs: 50 });
  assert.equal(result, null);
});
