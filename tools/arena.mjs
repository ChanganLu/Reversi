/**
 * arena.mjs — self-play matches between engine configurations.
 *
 *   node tools/arena.mjs --games 8 --a ab:2000 --b mcts:2000
 *
 * Each side is `engine:timeMs` to search per move, optionally with `:depth=N`
 * for the alpha-beta engine. Colours are alternated so a colour bias cannot
 * masquerade as strength. This is the tool used to pick the difficulty presets
 * and to sanity-check every engine change.
 */

import { BLACK, WHITE, applyMove, countDiscs, initialBoard, legalMoves } from '../js/game/rules.js';
import { POS_SIZE, encodePosition } from '../js/ai/bitboard.js';
import { MctsEngine } from '../js/ai/mcts.js';
import { AlphaBetaEngine } from '../js/ai/alphabeta.js';

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

/** Parses "ab:1500:depth=10" or "mcts:400:cutoff=8:explore=1.2" into a config. */
function parseSpec(spec) {
  const parts = spec.split(':');
  const name = parts[0];
  const timeMs = Number(parts[1] ?? 1000);
  const extra = {};
  for (const option of parts.slice(2)) {
    const [key, value] = option.split('=');
    extra[key] = Number(value);
  }
  return { name, timeMs, extra, label: spec };
}

function createEngine(spec, seed) {
  if (spec.name === 'ab') {
    return {
      kind: 'ab',
      engine: new AlphaBetaEngine({ tableBits: 16 }),
      spec,
      maxDepth: spec.extra.depth,
    };
  }
  return {
    kind: 'mcts',
    engine: new MctsEngine({
      seed,
      cutoffPlies: spec.extra.cutoff,
      exploration: spec.extra.explore,
      evalScale: spec.extra.scale,
    }),
    spec,
  };
}

async function requestMove(side, board, turn, moveHistory, lastSearchIndex) {
  const root = new Int32Array(POS_SIZE);
  encodePosition(board, turn, root);
  if (side.kind === 'ab') {
    const result = await side.engine.think(root, { timeMs: side.spec.timeMs, maxDepth: side.maxDepth });
    return { move: result ? result.move : null, stats: result };
  }
  const result = await side.engine.think(root, {
    timeMs: side.spec.timeMs,
    path: moveHistory.slice(lastSearchIndex),
  });
  return { move: result ? result.move : null, stats: result };
}

/**
 * Plays one game.
 * @returns {{winner:number|null, black:object, white:object, plies:number, stats:object}}
 */
async function playGame(blackSide, whiteSide, seed, label) {
  const board = initialBoard();
  const history = [];
  let turn = BLACK;
  let guard = 0;
  const counters = {
    blackSearch: 0,
    whiteSearch: 0,
    blackIterations: 0,
    whiteIterations: 0,
    blackNodes: 0,
    whiteNodes: 0,
  };
  let blackLast = 0;
  let whiteLast = 0;

  while (guard++ < 220) {
    const moves = legalMoves(board, turn);
    if (moves.length === 0) {
      if (legalMoves(board, turn ^ 3).length === 0) break;
      turn ^= 3;
      continue;
    }
    const side = turn === BLACK ? blackSide : whiteSide;
    const last = turn === BLACK ? blackLast : whiteLast;
    const { move, stats } = await requestMove(side, board, turn, history, last);
    if (move === null || !moves.includes(move)) {
      throw new Error(
        `${label}: ${turn === BLACK ? 'black' : 'white'} (${side.spec.label}) returned illegal move ${move}`,
      );
    }
    if (turn === BLACK) {
      blackLast = history.length;
      counters.blackSearch++;
      counters.blackIterations += stats?.iterations ?? 0;
      counters.blackNodes += stats?.nodes ?? 0;
    } else {
      whiteLast = history.length;
      counters.whiteSearch++;
      counters.whiteIterations += stats?.iterations ?? 0;
      counters.whiteNodes += stats?.nodes ?? 0;
    }
    applyMove(board, move, turn, turn ^ 3);
    history.push(move);
    turn ^= 3;
  }

  const { black, white } = countDiscs(board);
  return {
    winner: black === white ? 0 : black > white ? BLACK : WHITE,
    black,
    white,
    plies: history.length,
    counters,
    label,
  };
}

async function main() {
  const args = new Map();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    args.set(argv[i].replace(/^--/, ''), argv[i + 1]);
  }
  const games = Number(args.get('games') ?? 4);
  const specA = parseSpec(args.get('a') ?? 'mcts:1000');
  const specB = parseSpec(args.get('b') ?? 'ab:1000');

  console.log(`A = ${specA.label}    B = ${specB.label}    games = ${games}\n`);

  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  const started = Date.now();

  for (let game = 0; game < games; game++) {
    const aIsBlack = game % 2 === 0;
    const sideA = createEngine(specA, 1000 + game * 7919);
    const sideB = createEngine(specB, 2000 + game * 104729);
    const result = await playGame(
      aIsBlack ? sideA : sideB,
      aIsBlack ? sideB : sideA,
      game + 1,
      `game ${game + 1}`,
    );
    const aWon = aIsBlack ? result.winner === BLACK : result.winner === WHITE;
    const bWon = aIsBlack ? result.winner === WHITE : result.winner === BLACK;
    if (result.winner === 0) draws++;
    else if (aWon) winsA++;
    else if (bWon) winsB++;

    const tag = result.winner === 0 ? 'draw' : aWon ? 'A wins' : 'B wins';
    console.log(
      `game ${String(game + 1).padStart(2)}: ${tag.padEnd(8)} ` +
        `black ${String(result.black).padStart(2)} - ${String(result.white).padStart(2)} white ` +
        `(${result.plies} plies, A as ${aIsBlack ? 'black' : 'white'})`,
    );
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nA: ${winsA}  B: ${winsB}  draws: ${draws}   (${elapsed}s)`);
  const score = (winsA + draws * 0.5) / games;
  console.log(`A score: ${(score * 100).toFixed(1)}%`);
}

await main();
