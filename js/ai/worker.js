/**
 * worker.js — the AI runs here, off the main thread.
 *
 * Message protocol (main -> worker)
 * ---------------------------------
 *   { type: 'config',  engine: 'mcts' | 'ab', seed }
 *   { type: 'think',   id, board: number[], turn, path: number[],
 *                      timeMs, maxDepth, randomness }
 *   { type: 'cancel',  id }
 *   { type: 'reset' }                     drop any cached search state
 *
 * Worker -> main
 * --------------
 *   { type: 'ready' }
 *   { type: 'progress', id, stats }
 *   { type: 'result',   id, move, stats }
 *   { type: 'error',    id, message }
 *   { type: 'info',     engines }
 *
 * The engines are synchronous inside a single step, so the worker drains its
 * message queue between engine iterations (see ai/yield.js); that is what makes
 * cancellation feel instant.
 */

import { POS_SIZE, encodePosition } from './bitboard.js';
import { AlphaBetaEngine } from './alphabeta.js';
import { MctsEngine } from './mcts.js';
import { SQUARE_COUNT, generateMoves } from '../game/rules.js';

/** Scratch buffers reused across requests. */
const boardBuffer = new Uint8Array(64);
const position = new Int32Array(POS_SIZE);

let engineKind = 'mcts';
let seed = 0x9e3779b9;
/** @type {AlphaBetaEngine|MctsEngine} */
let engine = null;
/** Id of the newest request; anything older is stale and is ignored. */
let latestRequestId = 0;
const cancelled = new Set();

function createEngine(kind) {
  engineKind = kind;
  if (kind === 'ab') {
    engine = new AlphaBetaEngine({ tableBits: 17 });
  } else {
    engine = new MctsEngine({ seed });
  }
  return engine;
}

createEngine(engineKind);

self.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;

  switch (message.type) {
    case 'config': {
      seed = message.seed ?? seed;
      createEngine(message.engine === 'ab' ? 'ab' : 'mcts');
      self.postMessage({ type: 'info', engines: { active: engineKind } });
      break;
    }
    case 'reset': {
      if (engine instanceof MctsEngine) engine.reset();
      if (engine instanceof AlphaBetaEngine) engine.reset();
      break;
    }
    case 'cancel': {
      if (typeof message.id === 'number') cancelled.add(message.id);
      break;
    }
    case 'think': {
      void handleThink(message);
      break;
    }
    default:
      break;
  }
});

/**
 * Runs one search and posts the result.
 * @param {{id:number, board:number[], turn:number, path?:number[], timeMs?:number,
 *          maxDepth?:number, randomness?:number, seed?:number}} request
 */
async function handleThink(request) {
  const id = request.id;
  latestRequestId = Math.max(latestRequestId, id);
  // Clear the cancellation set for anything older than this request.
  for (const entry of cancelled) {
    if (entry < id) cancelled.delete(entry);
  }

  try {
    boardBuffer.set(request.board);
    encodePosition(boardBuffer, request.turn, position, 0);

    const timeMs = Math.max(1, Math.round(request.timeMs ?? 1000));
    const shouldAbort = () => cancelled.has(id) || id !== latestRequestId;
    const report = (stats) => {
      if (cancelled.has(id) || id !== latestRequestId) return;
      self.postMessage({ type: 'progress', id, stats: summarize(stats) });
    };

    let result;
    if (engineKind === 'ab') {
      result = await engine.think(position, {
        timeMs,
        maxDepth: request.maxDepth,
        onIteration: report,
        shouldAbort,
      });
    } else {
      result = await engine.think(position, {
        timeMs,
        path: Array.isArray(request.path) ? request.path : [],
        onProgress: report,
        shouldAbort,
      });
    }

    if (cancelled.has(id)) return;

    if (result === null) {
      // The searcher has no legal move: the UI has to pass.
      self.postMessage({ type: 'result', id, move: null, stats: { pass: true } });
      return;
    }

    let move = result.move;
    // Weakened levels occasionally play a random legal move instead, which is
    // what makes "Easy" actually easy without crippling the search itself.
    const randomness = Number(request.randomness ?? 0);
    if (randomness > 0 && Math.random() < randomness) {
      const legal = legalMovesOf(request.board, request.turn);
      if (legal.length > 1) move = legal[Math.floor(Math.random() * legal.length)];
    }

    self.postMessage({ type: 'result', id, move, stats: summarize(result), engine: engineKind });
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      message: error && error.message ? error.message : String(error),
    });
  }
}

/** Lists the legal moves of a plain board, used only by the random-move path. */
function legalMovesOf(board, turn) {
  boardBuffer.set(board);
  const list = new Uint8Array(SQUARE_COUNT);
  const count = generateMoves(boardBuffer, turn, list);
  return Array.from(list.subarray(0, count));
}

/** Keeps structured-clone payloads small: only the fields the UI displays. */
function summarize(stats) {
  if (!stats) return {};
  const summary = {
    move: stats.move,
    depth: stats.depth,
    nodes: stats.nodes,
    timeMs: stats.timeMs,
    score: stats.score,
    iterations: stats.iterations,
    rootVisits: stats.rootVisits,
    bestValue: stats.bestValue,
    bestVisits: stats.bestVisits,
    exact: stats.exact,
    proven: stats.proven,
    reused: stats.reused,
    pv: stats.pv,
    empties: stats.empties,
  };
  if (Array.isArray(stats.children)) {
    summary.children = stats.children.slice(0, 8).map((child) => ({
      move: child.move,
      visits: child.visits,
      value: child.value,
    }));
  }
  return summary;
}

self.postMessage({ type: 'ready', engine: engineKind });
