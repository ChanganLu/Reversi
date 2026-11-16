/**
 * bench.mjs — micro-benchmarks for the hot paths.
 *
 *   node tools/bench.mjs
 *
 * The numbers drive engine tuning: how many playouts or search nodes fit into a
 * move budget, and which primitives deserve more optimisation.
 */

import {
  BLACK,
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
  countMoves,
  discBalance,
  encodePosition,
  hasMove,
  moveMask,
  popcount64,
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

const rand = mulberry32(0x5eed);
const random = () => rand();
const movesBuf = new Uint8Array(64);

/** Random playout on the array board; returns the winner. */
function playoutArray(board, me) {
  let player = me;
  let passes = 0;
  for (let guard = 0; guard < 200; guard++) {
    const count = generateMoves(board, player, movesBuf);
    if (count === 0) {
      if (++passes >= 2) break;
      player ^= 3;
      continue;
    }
    passes = 0;
    applyMoveArray(board, movesBuf[(random() * count) | 0], player, player ^ 3);
    player ^= 3;
  }
  const { black, white } = countDiscs(board);
  return black === white ? 0 : black > white ? BLACK : WHITE;
}

/* --------------------------- bitboard playout --------------------- */

const posA = new Int32Array(POS_SIZE);
const posB = new Int32Array(POS_SIZE);
const extra = new Int32Array(POS_SIZE);
const mask = new Int32Array(2);

/** Random playout using bitboards: the engine's rollout kernel. */
function playoutBits(lo, hi, olo, ohi) {
  let mLo = lo;
  let mHi = hi;
  let oLo = olo;
  let oHi = ohi;
  let passes = 0;
  let sign = 1;
  for (let guard = 0; guard < 200; guard++) {
    const count = moveMask(mLo, mHi, oLo, oHi, mask);
    if (count === 0) {
      if (++passes >= 2) break;
      // Forced pass: swap sides and flip the sign of the result.
      let t = mLo; mLo = oLo; oLo = t;
      t = mHi; mHi = oHi; oHi = t;
      sign = -sign;
      continue;
    }
    passes = 0;
    // Uniformly random legal move out of the mask.
    const pick = (random() * count) | 0;
    let bits = mask[0];
    let chosen = -1;
    const lowCount = popcount64(mask[0], 0);
    if (pick < lowCount) {
      for (let i = 0; i <= pick; i++) {
        const b = bits & -bits;
        if (i === pick) chosen = 31 - Math.clz32(b);
        bits ^= b;
      }
    } else {
      bits = mask[1];
      for (let i = 0; i <= pick - lowCount; i++) {
        const b = bits & -bits;
        if (i === pick - lowCount) chosen = 32 + 31 - Math.clz32(b);
        bits ^= b;
      }
    }
    applyMove(mLo, mHi, oLo, oHi, chosen, extra);
    mLo = extra[0];
    mHi = extra[1];
    oLo = extra[2];
    oHi = extra[3];
  }
  const diff = sign * (popcount64(mLo, mHi) - popcount64(oLo, oHi));
  return diff > 0 ? 1 : diff < 0 ? -1 : 0;
}

function collectPositions(howMany, plies) {
  const positions = [];
  for (let i = 0; i < howMany; i++) {
    const board = initialBoard();
    let me = BLACK;
    let passes = 0;
    for (let p = 0; p < plies; p++) {
      const moves = legalMoves(board, me);
      if (!moves.length) {
        if (++passes >= 2) break;
        me ^= 3;
        continue;
      }
      passes = 0;
      applyMoveArray(board, moves[(random() * moves.length) | 0], me, me ^ 3);
      me ^= 3;
    }
    positions.push({ board, me });
  }
  return positions;
}

function bench(label, iterations, fn) {
  fn(1); // warm-up
  const start = performance.now();
  const result = fn(iterations);
  const elapsed = performance.now() - start;
  const perSecond = (iterations / elapsed) * 1000;
  console.log(
    `${label.padEnd(36)} ${String(iterations).padStart(8)} iters ` +
      `${elapsed.toFixed(0).padStart(7)} ms ${Math.round(perSecond).toLocaleString().padStart(10)} /s` +
      (result === undefined ? '' : `   ${result}`),
  );
}

console.log(`\nNode ${process.version} · ${process.arch}`);
console.log(`board = 2 x 64-bit masks in 32-bit halves\n`);

const positions = collectPositions(64, 22);

bench('array: generateMoves', 200000, (n) => {
  let total = 0;
  for (let i = 0; i < n; i++) total += generateMoves(positions[i & 63].board, positions[i & 63].me, movesBuf);
  return `moves=${total}`;
});

bench('bitboard: countMoves', 200000, (n) => {
  let total = 0;
  for (let i = 0; i < n; i++) {
    const p = positions[i & 63];
    encodePosition(p.board, p.me, posA);
    total += countMoves(posA[0], posA[1], posA[2], posA[3]);
  }
  return `moves=${total}`;
});

bench('bitboard: moveMask (pre-encoded)', 200000, (n) => {
  let total = 0;
  for (let i = 0; i < n; i++) {
    const p = positions[i & 63];
    encodePosition(p.board, p.me, posA);
    total += moveMask(posA[0], posA[1], posA[2], posA[3], mask);
  }
  return `moves=${total}`;
});

bench('bitboard: hasMove', 200000, (n) => {
  let total = 0;
  for (let i = 0; i < n; i++) {
    const p = positions[i & 63];
    encodePosition(p.board, p.me, posA);
    total += hasMove(posA[0], posA[1], posA[2], posA[3]) ? 1 : 0;
  }
  return `moves=${total}`;
});

bench('array: full playout', 20000, (n) => {
  const root = initialBoard();
  const scratch = new Uint8Array(64);
  let blackWins = 0;
  for (let i = 0; i < n; i++) {
    scratch.set(root);
    if (playoutArray(scratch, BLACK) === BLACK) blackWins++;
  }
  return `blackWins=${blackWins}`;
});

bench('bitboard: full playout', 20000, (n) => {
  encodePosition(initialBoard(), BLACK, posA);
  const lo = posA[0];
  const hi = posA[1];
  const olo = posA[2];
  const ohi = posA[3];
  let wins = 0;
  for (let i = 0; i < n; i++) if (playoutBits(lo, hi, olo, ohi) > 0) wins++;
  return `wins=${wins}`;
});

bench('bitboard: full playout (midgame)', 20000, (n) => {
  const encoded = positions.map((p) => {
    const buf = new Int32Array(POS_SIZE);
    encodePosition(p.board, p.me, buf);
    return buf;
  });
  let wins = 0;
  for (let i = 0; i < n; i++) {
    const p = encoded[i & 63];
    if (playoutBits(p[0], p[1], p[2], p[3]) > 0) wins++;
  }
  return `wins=${wins}`;
});

bench('bitboard: applyMove', 500000, (n) => {
  let total = 0;
  for (let i = 0; i < n; i++) {
    const p = positions[i & 63];
    encodePosition(p.board, p.me, posA);
    // Find a legal move cheaply, then apply it.
    const count = moveMask(posA[0], posA[1], posA[2], posA[3], mask);
    if (count === 0) continue;
    const b = mask[0] !== 0 ? mask[0] & -mask[0] : mask[1] & -mask[1];
    const sq = mask[0] !== 0 ? 31 - Math.clz32(b) : 63 - Math.clz32(b);
    applyMove(posA[0], posA[1], posA[2], posA[3], sq, posB);
    total += discBalance(posB[0], posB[1], posB[2], posB[3]);
  }
  return `sum=${total}`;
});

void WHITE;
void swapSides;
console.log('');
