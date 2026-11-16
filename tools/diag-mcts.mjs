/**
 * diag-mcts.mjs — engine vs random diagnostics.
 *
 *   node tools/diag-mcts.mjs [games] [timeMs] [useReuse]
 */
import { BLACK, WHITE, applyMove, countDiscs, initialBoard, legalMoves } from '../js/game/rules.js';
import { POS_SIZE, encodePosition } from '../js/ai/bitboard.js';
import { MctsEngine } from '../js/ai/mcts.js';

const games = Number(process.argv[2] ?? 6);
const timeMs = Number(process.argv[3] ?? 120);
const useReuse = (process.argv[4] ?? 'true') !== 'false';

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

async function play(engine, engineColor, seed) {
  const rand = mulberry32(seed);
  const board = initialBoard();
  const played = [];
  let turn = BLACK;
  let last = 0;
  let guard = 0;
  let totalIterations = 0;
  while (guard++ < 200) {
    const moves = legalMoves(board, turn);
    if (moves.length === 0) {
      if (legalMoves(board, turn ^ 3).length === 0) break;
      turn ^= 3;
      continue;
    }
    let move;
    if (turn === engineColor) {
      encodePosition(board, turn, root);
      const result = await engine.think(root, {
        timeMs,
        path: useReuse ? played.slice(last) : [],
      });
      last = played.length;
      totalIterations += result.iterations;
      move = result.move;
      if (!moves.includes(move)) throw new Error(`illegal ${move}`);
    } else {
      move = moves[Math.floor(rand() * moves.length)];
    }
    applyMove(board, move, turn, turn ^ 3);
    played.push(move);
    turn ^= 3;
  }
  const { black, white } = countDiscs(board);
  return { black, white, winner: black === white ? 0 : black > white ? BLACK : WHITE, totalIterations };
}

const engine = new MctsEngine({ seed: 12345 });
let engineWins = 0;
for (let game = 0; game < games; game++) {
  const color = game % 2 === 0 ? BLACK : WHITE;
  if (game % 2 === 0) engine.reset();
  const result = await play(engine, color, 1000 + game * 77);
  const won = result.winner === color;
  if (won) engineWins++;
  console.log(
    `game ${game + 1}: engine as ${color === BLACK ? 'black' : 'white'} ` +
      `${won ? 'WON ' : result.winner === 0 ? 'DRAW' : 'LOST'} ` +
      `(${result.black}-${result.white}) iterations=${result.totalIterations}`,
  );
}
console.log(`\nengine won ${engineWins}/${games}  (time ${timeMs}ms, reuse ${useReuse})`);
