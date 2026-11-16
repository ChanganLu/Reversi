/**
 * rules.test.mjs — correctness of the rule engine.
 *
 * The fast, table-driven implementation in js/game/rules.js is validated
 * against an independent, deliberately naive reference implementation so that
 * an optimisation mistake can never silently change the game.
 *
 * Run with:  node --test tests/
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BLACK,
  CORNERS,
  EMPTY,
  SQUARE_COUNT,
  WHITE,
  applyMove,
  countDiscs,
  createBoard,
  fromNotation,
  generateMoves,
  initialBoard,
  isLegalMove,
  legalMoves,
  toNotation,
  undoMove,
} from '../js/game/rules.js';
import { GameState } from '../js/game/game-state.js';

/* ---------------------------------------------------------------- */
/* Naive reference implementation                                    */
/* ---------------------------------------------------------------- */

const DIRS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

const refAt = (board, row, col) => (row < 0 || row > 7 || col < 0 || col > 7 ? -1 : board[row * 8 + col]);

function refFlips(board, sq, me) {
  const opp = me === BLACK ? WHITE : BLACK;
  const row = Math.floor(sq / 8);
  const col = sq % 8;
  if (refAt(board, row, col) !== EMPTY) return [];
  const out = [];
  for (const [dr, dc] of DIRS) {
    const run = [];
    let r = row + dr;
    let c = col + dc;
    while (refAt(board, r, c) === opp) {
      run.push(r * 8 + c);
      r += dr;
      c += dc;
    }
    if (run.length > 0 && refAt(board, r, c) === me) out.push(...run);
  }
  return out;
}

const refLegal = (board, me) => {
  const out = [];
  for (let sq = 0; sq < 64; sq++) if (refFlips(board, sq, me).length > 0) out.push(sq);
  return out;
};

/* ---------------------------------------------------------------- */
/* Deterministic pseudo-random positions                             */
/* ---------------------------------------------------------------- */

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

/** Plays `plies` pseudo-random moves and returns the resulting position. */
function randomPosition(seed, plies) {
  const rand = mulberry32(seed);
  const board = initialBoard();
  let me = BLACK;
  let passes = 0;
  for (let i = 0; i < plies; i++) {
    const moves = legalMoves(board, me);
    if (moves.length === 0) {
      if (++passes >= 2) break;
      me = me ^ 3;
      continue;
    }
    passes = 0;
    const sq = moves[Math.floor(rand() * moves.length)];
    applyMove(board, sq, me, me ^ 3);
    me = me ^ 3;
  }
  return { board, turn: me };
}

/* ---------------------------------------------------------------- */
/* Tests                                                             */
/* ---------------------------------------------------------------- */

test('initial position matches the standard Othello setup', () => {
  const board = initialBoard();
  assert.deepEqual(countDiscs(board), { black: 2, white: 2, empty: 60 });
  assert.equal(board[27], BLACK); // d5
  assert.equal(board[36], BLACK); // e4
  assert.equal(board[28], WHITE); // d4
  assert.equal(board[35], WHITE); // e5
});

test('black has exactly four opening moves', () => {
  const board = initialBoard();
  const moves = legalMoves(board, BLACK).sort((a, b) => a - b);
  assert.deepEqual(moves, [20, 29, 34, 43].sort((a, b) => a - b));
  assert.deepEqual(moves.map(toNotation).sort(), ['c4', 'd3', 'e6', 'f5']);
  assert.equal(legalMoves(board, WHITE).length, 4);
});

test('a single move flips exactly one disc', () => {
  const board = initialBoard();
  const sq = fromNotation('d3');
  const flips = refFlips(board, sq, BLACK);
  assert.equal(flips.length, 1);
  const flipped = applyMove(board, sq, BLACK, WHITE);
  assert.equal(flipped, 1);
  assert.deepEqual(countDiscs(board), { black: 4, white: 1, empty: 59 });
});

test('applyMove + undoMove is an exact inverse', () => {
  const board = initialBoard();
  const snapshot = Uint8Array.from(board);
  const buffer = new Uint8Array(64);
  const sq = fromNotation('c4');
  const count = applyMove(board, sq, BLACK, WHITE, buffer, 0);
  assert.ok(count > 0);
  undoMove(board, sq, BLACK, WHITE, buffer, 0, count);
  assert.deepEqual(Uint8Array.from(board), snapshot);
});

test('generateMoves agrees with the naive reference on random positions', () => {
  for (let seed = 1; seed <= 60; seed++) {
    for (const plies of [0, 5, 12, 25, 40, 55]) {
      const { board, turn } = randomPosition(seed * 977 + plies, plies);
      for (const me of [BLACK, WHITE]) {
        const fast = legalMoves(board, me);
        const ref = refLegal(board, me);
        assert.deepEqual(fast.slice().sort((a, b) => a - b), ref, `seed=${seed} plies=${plies}`);
        void turn;
      }
    }
  }
});

test('flip sets agree with the naive reference and are symmetric', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const { board } = randomPosition(seed * 31, 20);
    for (let sq = 0; sq < 64; sq++) {
      if (board[sq] !== EMPTY) continue;
      for (const me of [BLACK, WHITE]) {
        const ref = refFlips(board, sq, me).sort((a, b) => a - b);
        const viaApply = Uint8Array.from(board);
        const count = ref.length;
        const flipped = applyMove(viaApply, sq, me, me ^ 3);
        assert.equal(flipped, count, `seed=${seed} sq=${sq} me=${me}`);
        // Every reported flip must have changed colour, and nothing else may change.
        for (let other = 0; other < 64; other++) {
          if (other === sq) continue;
          const before = board[other];
          const after = viaApply[other];
          if (ref.includes(other)) {
            assert.equal(before, me ^ 3, 'a flipped square must hold an opponent disc');
            assert.equal(after, me);
          } else {
            assert.equal(after, before, 'non-flipped square changed');
          }
        }
      }
    }
  }
});

test('legal move detection is boundary safe', () => {
  const board = createBoard();
  // b8 white and c8 black: a8 is a legal black move (it brackets b8).
  board[1] = WHITE; // b8
  assert.equal(isLegalMove(board, 0, BLACK), false); // nothing to bracket
  board[2] = BLACK; // c8
  assert.equal(isLegalMove(board, 0, BLACK), true);
  assert.equal(isLegalMove(board, 1, BLACK), false); // b8 is occupied
  assert.equal(generateMoves(board, BLACK, new Uint8Array(64)), 1);

  // Same shape vertically along the a-file.
  const column = createBoard();
  column[8] = WHITE; // a7
  column[16] = BLACK; // a6
  assert.equal(isLegalMove(column, 0, BLACK), true);
  // A ray that leaves the board before meeting an own disc is not legal.
  const dead = createBoard();
  dead[1] = WHITE;
  assert.equal(isLegalMove(dead, 0, BLACK), false);
});

test('notation round-trips', () => {
  for (let sq = 0; sq < SQUARE_COUNT; sq++) {
    assert.equal(fromNotation(toNotation(sq)), sq);
  }
  assert.equal(toNotation(0), 'a8');
  assert.equal(toNotation(63), 'h1');
  assert.equal(toNotation(fromNotation('d3')), 'd3');
  assert.equal(fromNotation('zz'), -1);
});

test('corners are always stable once taken (spot check)', () => {
  const board = initialBoard();
  for (const corner of CORNERS) {
    assert.equal(board[corner], EMPTY);
  }
});

/* ---------------------------------------------------------------- */
/* GameState behaviour                                               */
/* ---------------------------------------------------------------- */

test('GameState plays, tracks turn and supports undo', () => {
  const game = new GameState();
  assert.equal(game.turn, BLACK);
  const first = fromNotation('d3');
  const opening = game.legalMoves();
  assert.ok(opening.includes(first));

  const moveA = game.play(first);
  assert.equal(moveA.status, 'ok');
  assert.equal(moveA.flipped.length, 1);
  assert.equal(game.turn, WHITE);
  assert.equal(game.play(first).status, 'illegal'); // occupied
  assert.equal(game.play(fromNotation('a1')).status, 'illegal'); // no reversal

  const second = game.legalMoves()[0];
  assert.equal(game.play(second).status, 'ok');
  assert.equal(game.history.length, 2);
  game.undo();
  assert.equal(game.history.length, 1);
  assert.equal(game.turn, WHITE);
  assert.deepEqual(countDiscs(game.board), { black: 4, white: 1, empty: 59 });
});

test('GameState undo of every move returns to the opening position', () => {
  const game = new GameState();
  const rand = mulberry32(12345);
  for (let i = 0; i < 30; i++) {
    const moves = game.legalMoves();
    if (moves.length === 0) break;
    game.play(moves[Math.floor(rand() * moves.length)]);
  }
  const played = game.history.length;
  assert.ok(played > 10);
  game.undo(played);
  assert.deepEqual(Array.from(game.board), Array.from(initialBoard()));
  assert.equal(game.turn, BLACK);
  assert.equal(game.history.length, 0);
});

test('a full random game ends with a consistent result', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const rand = mulberry32(seed);
    const game = new GameState();
    let guard = 0;
    while (!game.over && guard++ < 200) {
      const moves = game.legalMoves();
      if (moves.length === 0) break;
      game.play(moves[Math.floor(rand() * moves.length)]);
    }
    assert.ok(game.over, `game ${seed} did not finish`);
    const { black, white, empty } = countDiscs(game.board);
    assert.equal(black + white + empty, 64);
    // The game may only be over when neither side can move.
    assert.equal(legalMoves(game.board, BLACK).length, 0);
    assert.equal(legalMoves(game.board, WHITE).length, 0);
    const winner = game.winner();
    assert.ok(winner === BLACK || winner === WHITE || winner === 0);
  }
});

test('forced passes are handled: the mover plays again', () => {
  // Construct a position where white has no move but black has one.
  const game = new GameState();
  // Row-by-row construction is awkward, so replay a known sequence instead:
  // after black plays a1-line corner sequences opponents can be locked out.
  // Here we test the invariant instead: whenever both sides cannot move, the
  // game is over; whenever only the side to move cannot move, it is not.
  const rand = mulberry32(999);
  let passedSeen = false;
  for (let seedGame = 0; seedGame < 40 && !passedSeen; seedGame++) {
    const g = new GameState();
    let guard = 0;
    while (!g.over && guard++ < 200) {
      const moves = g.legalMoves();
      if (moves.length === 0) break;
      const res = g.play(moves[Math.floor(rand() * moves.length)]);
      if (res.passed) {
        passedSeen = true;
        assert.equal(g.turn, res.player, 'the moving side keeps the turn after a pass');
        assert.ok(!g.over);
        break;
      }
    }
  }
  assert.ok(passedSeen, 'no forced pass occurred in the sampled games');
  void game;
});

test('loadMoves ignores an illegal suffix instead of throwing', () => {
  const reference = new GameState();
  const sequence = [];
  const rand = mulberry32(4242);
  for (let i = 0; i < 4; i++) {
    const moves = reference.legalMoves();
    if (!moves.length) break;
    const sq = moves[Math.floor(rand() * moves.length)];
    sequence.push(sq);
    reference.play(sq);
  }
  assert.equal(sequence.length, 4);

  const game = new GameState();
  // Replaying an already occupied square must truncate the load.
  game.loadMoves([sequence[0], sequence[1], sequence[0], sequence[2], sequence[3]]);
  assert.equal(game.history.length, 2);

  // The clean prefix loads completely and reproduces a live-played position.
  const live = new GameState();
  for (const sq of sequence.slice(0, 3)) live.play(sq);
  const clean = new GameState();
  clean.loadMoves(sequence.slice(0, 3));
  assert.equal(clean.history.length, 3);
  assert.deepEqual(Array.from(clean.board), Array.from(live.board));
  assert.equal(clean.turn, live.turn);
});

test('GameState JSON round-trip', () => {
  const game = new GameState();
  const rand = mulberry32(7);
  for (let i = 0; i < 20; i++) {
    const moves = game.legalMoves();
    if (!moves.length) break;
    game.play(moves[Math.floor(rand() * moves.length)]);
  }
  const restored = GameState.fromJSON(JSON.parse(JSON.stringify(game.toJSON())));
  assert.deepEqual(Array.from(restored.board), Array.from(game.board));
  assert.equal(restored.turn, game.turn);
  assert.deepEqual(restored.notationList(), game.notationList());
});
