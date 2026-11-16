/**
 * alphabeta.js — the "deep search" engine.
 *
 * A classic Reversi searcher: iterative deepening, principal variation search,
 * a transposition table, killer moves and a history heuristic, ordered by the
 * mobility the opponent is left with. Because Reversi has a small branching
 * factor and no quiet positions, alpha-beta plays noticeably better per unit of
 * time than random-playout MCTS — and in the last plies it solves the position
 * exactly.
 *
 * Scores are always from the point of view of the player to move. A position is
 * a quadruple of int32 bitboard halves, exactly as produced by bitboard.js:
 * `[ownLo, ownHi, oppLo, oppHi]`.
 *
 * The hot recursion path deliberately allocates nothing: hash words, table
 * probes and move lists all live in preallocated fields.
 */

import { POS_SIZE, applyMove, hasMove, moveMask, popcount64 } from './bitboard.js';
import { EVAL_LIMIT, WIN_SCORE, evaluate, terminalScore } from './evaluate.js';
import { now, yieldToEventLoop } from './yield.js';

/** Thrown internally to unwind the recursion when the time budget expires. */
const ABORT = Symbol('abort');

export const INFINITY = WIN_SCORE * 4;

/** Maximum number of plies the search stack can hold. */
export const MAX_PLY = 72;

/** Transposition-table bound flags. */
const TT_EMPTY = 0;
const TT_EXACT = 1;
const TT_LOWER = 2;
const TT_UPPER = 3;

/**
 * Static ordering hint per square: corners are the best moves, the X and C
 * squares next to a corner are the worst.
 */
const SQUARE_ORDER = new Int32Array(64);
(() => {
  for (let sq = 0; sq < 64; sq++) {
    const row = sq >> 3;
    const col = sq & 7;
    const edgeDistance = Math.min(row, col, 7 - row, 7 - col);
    SQUARE_ORDER[sq] = 40 - edgeDistance * 6;
  }
  for (const sq of [0, 7, 56, 63]) SQUARE_ORDER[sq] = 320; // corners
  for (const sq of [9, 14, 49, 54]) SQUARE_ORDER[sq] = -160; // X squares
  for (const sq of [1, 6, 8, 15, 48, 55, 57, 62]) SQUARE_ORDER[sq] = -90; // C squares
})();

/** Default options for the engine. */
export const DEFAULT_AB_OPTIONS = {
  /** Hard cap on thinking time in milliseconds. */
  timeMs: 1200,
  /** Upper bound on the search depth (the endgame searches to the end anyway). */
  maxDepth: 22,
};

export class AlphaBetaEngine {
  /** @param {{tableBits?: number}} [config] */
  constructor(config = {}) {
    const tableBits = config.tableBits ?? 17;
    this.tableSize = 1 << tableBits;
    this.tableMask = this.tableSize - 1;

    this.pos = new Int32Array(POS_SIZE * MAX_PLY);
    this.maskOut = new Int32Array(2);
    this.rootMask = new Int32Array(2);
    /**
     * Move lists are stored per ply. A node's ordering state must survive the
     * recursive calls it makes, so sharing one array between plies would let a
     * child overwrite its parent's remaining moves.
     */
    this.moveStack = new Uint8Array(MAX_PLY * 64);
    this.scoreStack = new Int32Array(MAX_PLY * 64);
    this.rootMoves = new Uint8Array(64);
    this.rootScores = new Int32Array(64);
    this.childPos = new Int32Array(POS_SIZE);

    this.killers = new Int32Array(MAX_PLY * 2);
    this.history = new Int32Array(64);

    this.ttKeyLo = new Int32Array(this.tableSize);
    this.ttKeyHi = new Int32Array(this.tableSize);
    this.ttScore = new Int32Array(this.tableSize);
    this.ttDepth = new Int8Array(this.tableSize);
    this.ttFlag = new Int8Array(this.tableSize);
    this.ttMove = new Int8Array(this.tableSize).fill(-1);

    // Scratch results published by hashPosition()/ttProbe() (no allocation).
    this.hashLo = 0;
    this.hashHi = 0;
    this.ttHit = false;
    this.ttHitScore = 0;
    this.ttHitMove = -1;
    this.ttIndex = 0;

    this.rootLo = 0;
    this.rootHi = 0;
    this.rootOppLo = 0;
    this.rootOppHi = 0;

    this.nodes = 0;
    this.ttHits = 0;
    this.deadline = 0;
    this.abortRequested = false;
    this.nodeCheckInterval = 512;
  }

  /** Clears the transposition table and the ordering heuristics. */
  reset() {
    this.ttFlag.fill(TT_EMPTY);
    this.ttMove.fill(-1);
    this.killers.fill(0);
    this.history.fill(0);
    this.nodes = 0;
    this.ttHits = 0;
    this.abortRequested = false;
  }

  /* ---------------------------------------------------------------- */
  /* Transposition table                                               */
  /* ---------------------------------------------------------------- */

  /** Publishes a two-word hash of the position into this.hashLo/this.hashHi. */
  hashPosition(ownLo, ownHi, oppLo, oppHi) {
    let a = Math.imul(ownLo ^ 0x9e3779b9, 0x85ebca6b);
    a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35);
    let b = Math.imul(ownHi ^ 0x27d4eb2f, 0x165667b1);
    b = Math.imul(b ^ (b >>> 15), 0x27d4eb2f);
    let c = Math.imul(oppLo ^ 0x7f4a7c15, 0x9e3779b1);
    c = Math.imul(c ^ (c >>> 16), 0x85ebca6b);
    let d = Math.imul(oppHi ^ 0x1b873593, 0xcc9e2d51);
    d = Math.imul(d ^ (d >>> 13), 0x1b873593);
    this.hashLo = (a ^ c ^ (b >>> 1)) | 0;
    this.hashHi = (b ^ d ^ (a >>> 1)) | 0;
    this.ttIndex = this.hashLo & this.tableMask;
  }

  /**
   * Looks the position up. Sets this.ttHit (and on a hit this.ttHitScore);
   * this.ttHitMove always holds the best move recorded for the position, or -1.
   */
  ttProbe(ownLo, ownHi, oppLo, oppHi, depth, alpha, beta, ply) {
    this.hashPosition(ownLo, ownHi, oppLo, oppHi);
    this.ttHit = false;
    this.ttHitMove = -1;
    if (this.ttFlag[this.ttIndex] === TT_EMPTY) return false;
    if (this.ttKeyLo[this.ttIndex] !== this.hashLo || this.ttKeyHi[this.ttIndex] !== this.hashHi) {
      return false;
    }
    const storedMove = this.ttMove[this.ttIndex];
    if (storedMove >= 0) this.ttHitMove = storedMove;
    if (this.ttDepth[this.ttIndex] < depth) return false;

    let score = this.ttScore[this.ttIndex];
    // Mate-like scores are stored ply-independent.
    if (score > EVAL_LIMIT) score -= ply;
    else if (score < -EVAL_LIMIT) score += ply;

    const flag = this.ttFlag[this.ttIndex];
    if (flag === TT_EXACT) {
      this.ttHit = true;
      this.ttHitScore = score;
      return true;
    }
    if (flag === TT_LOWER) {
      if (score > alpha) alpha = score;
    } else if (flag === TT_UPPER && score < beta) {
      beta = score;
    }
    if (alpha >= beta) {
      this.ttHit = true;
      this.ttHitScore = score;
      return true;
    }
    return false;
  }

  ttStore(depth, score, flag, move, ply) {
    if (this.ttFlag[this.ttIndex] !== TT_EMPTY && this.ttDepth[this.ttIndex] > depth) return;
    let stored = score;
    if (stored > EVAL_LIMIT) stored += ply;
    else if (stored < -EVAL_LIMIT) stored -= ply;
    this.ttKeyLo[this.ttIndex] = this.hashLo;
    this.ttKeyHi[this.ttIndex] = this.hashHi;
    this.ttScore[this.ttIndex] = stored;
    this.ttDepth[this.ttIndex] = depth > 127 ? 127 : depth;
    this.ttFlag[this.ttIndex] = flag;
    if (move >= 0) this.ttMove[this.ttIndex] = move;
  }

  /* ---------------------------------------------------------------- */
  /* Search                                                            */
  /* ---------------------------------------------------------------- */

  timeUp() {
    return this.abortRequested || now() >= this.deadline;
  }

  /** Pulls the legal moves of the current scratch mask into the move list. */
  collectMoves(ply) {
    const moves = this.moveStack;
    const base = ply * 64;
    let count = 0;
    let word = this.maskOut[0];
    while (word !== 0) {
      const bit = word & -word;
      moves[base + count++] = 31 - Math.clz32(bit);
      word ^= bit;
    }
    word = this.maskOut[1];
    while (word !== 0) {
      const bit = word & -word;
      moves[base + count++] = 32 + 31 - Math.clz32(bit);
      word ^= bit;
    }
    return count;
  }

  /**
   * Negamax with principal variation search.
   *
   * @param {number} ply distance from the root (also the search-stack slot)
   * @param {number} depth remaining depth
   * @param {number} alpha
   * @param {number} beta
   * @returns {number} score from the point of view of the player to move
   */
  search(ply, depth, alpha, beta) {
    this.nodes++;
    if ((this.nodes & this.nodeCheckInterval) === 0 && this.timeUp()) throw ABORT;

    const base = ply * POS_SIZE;
    const ownLo = this.pos[base];
    const ownHi = this.pos[base + 1];
    const oppLo = this.pos[base + 2];
    const oppHi = this.pos[base + 3];

    const moveCount = moveMask(ownLo, ownHi, oppLo, oppHi, this.maskOut);

    if (moveCount === 0) {
      if (!hasMove(oppLo, oppHi, ownLo, ownHi)) {
        return terminalScore(popcount64(ownLo, ownHi) - popcount64(oppLo, oppHi));
      }
      // Forced pass: the opponent plays twice, modelled as a side swap.
      const nextBase = base + POS_SIZE;
      this.pos[nextBase] = oppLo;
      this.pos[nextBase + 1] = oppHi;
      this.pos[nextBase + 2] = ownLo;
      this.pos[nextBase + 3] = ownHi;
      return -this.search(ply + 1, depth - 1, -beta, -alpha);
    }

    if (depth <= 0) {
      return evaluate(ownLo, ownHi, oppLo, oppHi, moveCount);
    }

    const alphaOrig = alpha;
    if (this.ttProbe(ownLo, ownHi, oppLo, oppHi, depth, alpha, beta, ply)) {
      this.ttHits++;
      return this.ttHitScore;
    }
    const ttMove = this.ttHitMove;

    const count = this.collectMoves(ply);
    const moves = this.moveStack;
    const scores = this.scoreStack;
    const moveBase = ply * 64;
    for (let i = 0; i < count; i++) scores[moveBase + i] = this.orderScore(moves[moveBase + i], ttMove, ply);

    const nextBase = base + POS_SIZE;
    let bestScore = -INFINITY;
    let bestMove = moves[moveBase];
    let played = 0;
    let index = 0;

    while (index < count) {
      // Selection sort: pull out the highest scored remaining move.
      let pick = index;
      for (let i = index + 1; i < count; i++) {
        if (scores[moveBase + i] > scores[moveBase + pick]) pick = i;
      }
      if (pick !== index) {
        const moveSwap = moves[moveBase + index];
        moves[moveBase + index] = moves[moveBase + pick];
        moves[moveBase + pick] = moveSwap;
        const scoreSwap = scores[moveBase + index];
        scores[moveBase + index] = scores[moveBase + pick];
        scores[moveBase + pick] = scoreSwap;
      }
      const sq = moves[moveBase + index];
      index++;
      played++;

      applyMove(ownLo, ownHi, oppLo, oppHi, sq, this.pos, nextBase);

      let score;
      if (played === 1) {
        score = -this.search(ply + 1, depth - 1, -beta, -alpha);
      } else {
        score = -this.search(ply + 1, depth - 1, -alpha - 1, -alpha);
        if (score > alpha && score < beta) {
          score = -this.search(ply + 1, depth - 1, -beta, -alpha);
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestMove = sq;
        if (score > alpha) {
          alpha = score;
          if (alpha >= beta) {
            if (this.killers[ply * 2] !== sq) {
              this.killers[ply * 2 + 1] = this.killers[ply * 2];
              this.killers[ply * 2] = sq;
            }
            this.history[sq] += depth * depth;
            break;
          }
        }
      }
    }

    const flag = bestScore <= alphaOrig ? TT_UPPER : bestScore >= beta ? TT_LOWER : TT_EXACT;
    this.ttStore(depth, bestScore, flag, bestMove, ply);
    return bestScore;
  }

  /** Ordering key: static square value, killers, history, hash move. */
  orderScore(sq, ttMove, ply) {
    if (sq === ttMove) return 1 << 24;
    if (sq === this.killers[ply * 2]) return (1 << 23) + SQUARE_ORDER[sq];
    if (sq === this.killers[ply * 2 + 1]) return (1 << 22) + SQUARE_ORDER[sq];
    const history = this.history[sq];
    return SQUARE_ORDER[sq] * 4096 + (history < 1 << 20 ? history : 1 << 20);
  }

  /**
   * One iteration of the root search. Returns the best move and its score, or
   * null when the position has no legal move.
   */
  searchRoot(depth, alpha, beta) {
    const ownLo = this.pos[0];
    const ownHi = this.pos[1];
    const oppLo = this.pos[2];
    const oppHi = this.pos[3];
    const moveCount = moveMask(ownLo, ownHi, oppLo, oppHi, this.rootMask);
    if (moveCount === 0) return null;

    this.ttProbe(ownLo, ownHi, oppLo, oppHi, depth, alpha, beta, 0);
    const ttMove = this.ttHitMove;

    const moves = this.rootMoves;
    const scores = this.rootScores;
    let count = 0;
    let word = this.rootMask[0];
    while (word !== 0) {
      const bit = word & -word;
      moves[count++] = 31 - Math.clz32(bit);
      word ^= bit;
    }
    word = this.rootMask[1];
    while (word !== 0) {
      const bit = word & -word;
      moves[count++] = 32 + 31 - Math.clz32(bit);
      word ^= bit;
    }

    // Root ordering: prefer moves that leave the opponent the fewest replies
    // (the classic mobility heuristic), with the hash move pinned first.
    const childPos = this.childPos;
    for (let i = 0; i < count; i++) {
      const sq = moves[i];
      applyMove(ownLo, ownHi, oppLo, oppHi, sq, childPos, 0);
      const replies = moveMask(childPos[0], childPos[1], childPos[2], childPos[3], this.maskOut);
      let score = -replies * 1000 + SQUARE_ORDER[sq];
      if (sq === ttMove) score += 1 << 24;
      scores[i] = score;
    }

    let bestScore = -INFINITY;
    let bestMove = -1;
    let alphaLocal = alpha;
    let played = 0;

    for (let order = 0; order < count; order++) {
      let pick = order;
      for (let i = order + 1; i < count; i++) if (scores[i] > scores[pick]) pick = i;
      if (pick !== order) {
        const moveSwap = moves[order];
        moves[order] = moves[pick];
        moves[pick] = moveSwap;
        const scoreSwap = scores[order];
        scores[order] = scores[pick];
        scores[pick] = scoreSwap;
      }
      const sq = moves[order];
      applyMove(ownLo, ownHi, oppLo, oppHi, sq, this.pos, POS_SIZE);
      played++;

      let score;
      if (played === 1) {
        score = -this.search(1, depth - 1, -beta, -alphaLocal);
      } else {
        score = -this.search(1, depth - 1, -alphaLocal - 1, -alphaLocal);
        if (score > alphaLocal && score < beta) {
          score = -this.search(1, depth - 1, -beta, -alphaLocal);
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestMove = sq;
        if (score > alphaLocal) alphaLocal = score;
      }
    }

    // Store with the root position's own hash words.
    this.hashPosition(ownLo, ownHi, oppLo, oppHi);
    this.ttStore(depth, bestScore, TT_EXACT, bestMove, 0);
    return { move: bestMove, score: bestScore };
  }

  /**
   * Walks the transposition table from the root to recover the principal
   * variation, for display.
   * @returns {number[]} square indices
   */
  principalVariation(maxLength = 12) {
    const pv = [];
    const current = new Int32Array(POS_SIZE);
    const buffer = new Int32Array(POS_SIZE);
    const mask = new Int32Array(2);
    current[0] = this.rootLo;
    current[1] = this.rootHi;
    current[2] = this.rootOppLo;
    current[3] = this.rootOppHi;

    for (let i = 0; i < maxLength; i++) {
      if (moveMask(current[0], current[1], current[2], current[3], mask) === 0) break;
      this.hashPosition(current[0], current[1], current[2], current[3]);
      const index = this.ttIndex;
      if (this.ttFlag[index] === TT_EMPTY) break;
      if (this.ttKeyLo[index] !== this.hashLo || this.ttKeyHi[index] !== this.hashHi) break;
      const move = this.ttMove[index];
      if (move < 0) break;
      const present = move < 32 ? ((mask[0] >>> move) & 1) === 1 : ((mask[1] >>> (move - 32)) & 1) === 1;
      if (!present) break;
      pv.push(move);
      applyMove(current[0], current[1], current[2], current[3], move, buffer, 0);
      current[0] = buffer[0];
      current[1] = buffer[1];
      current[2] = buffer[2];
      current[3] = buffer[3];
    }
    return pv;
  }

  /** Number of empty squares in the root position. */
  rootEmpties() {
    return 64 - popcount64(this.rootLo, this.rootHi) - popcount64(this.rootOppLo, this.rootOppHi);
  }

  /**
   * Iterative deepening driver.
   *
   * @param {Int32Array} root position `[ownLo, ownHi, oppLo, oppHi]`
   * @param {object} [options]
   * @param {number} [options.timeMs] thinking time budget
   * @param {number} [options.maxDepth] depth cap
   * @param {(info:object)=>void} [options.onIteration] called after each depth
   * @param {()=>boolean} [options.shouldAbort] polled between iterations
   * @returns {Promise<{move:number, score:number, depth:number, nodes:number, timeMs:number, pv:number[], exact:boolean}|null>}
   */
  async think(root, options = {}) {
    const timeMs = options.timeMs ?? DEFAULT_AB_OPTIONS.timeMs;
    const maxDepth = Math.min(options.maxDepth ?? DEFAULT_AB_OPTIONS.maxDepth, MAX_PLY - 4);
    const onIteration = options.onIteration;
    const shouldAbort = options.shouldAbort;

    this.reset();
    const started = now();
    this.deadline = started + timeMs;

    this.rootLo = root[0];
    this.rootHi = root[1];
    this.rootOppLo = root[2];
    this.rootOppHi = root[3];
    this.pos[0] = root[0];
    this.pos[1] = root[1];
    this.pos[2] = root[2];
    this.pos[3] = root[3];

    if (moveMask(root[0], root[1], root[2], root[3], this.rootMask) === 0) return null;

    const empties = this.rootEmpties();
    const depthLimit = Math.min(maxDepth, empties + 2);

    let best = null;
    for (let depth = 1; depth <= depthLimit; depth++) {
      try {
        const result = this.searchRoot(depth, -INFINITY, INFINITY);
        if (result === null) break;
        const proven = Math.abs(result.score) > WIN_SCORE;
        best = {
          move: result.move,
          score: result.score,
          depth,
          nodes: this.nodes,
          timeMs: now() - started,
          pv: this.principalVariation(Math.min(depth, 12)),
          exact: proven || depth >= empties,
          proven,
          empties,
        };
        if (onIteration) onIteration(best);
        if (proven || depth >= empties) break;
      } catch (error) {
        if (error !== ABORT) throw error;
        break;
      }
      // Let the worker drain its message queue (cancel requests in particular).
      await yieldToEventLoop();
      if (shouldAbort && shouldAbort()) break;
      if (now() >= this.deadline) break;
    }

    if (best === null) {
      // Budget too small to finish even depth 1: play a legal move immediately.
      moveMask(root[0], root[1], root[2], root[3], this.rootMask);
      const lowWord = this.rootMask[0];
      if (lowWord !== 0) {
        const bit = lowWord & -lowWord;
        const move = 31 - Math.clz32(bit);
        return { move, score: 0, depth: 0, nodes: this.nodes, timeMs: now() - started, pv: [move], exact: false, empties };
      }
      const highWord = this.rootMask[1];
      const bit = highWord & -highWord;
      const move = 32 + 31 - Math.clz32(bit);
      return { move, score: 0, depth: 0, nodes: this.nodes, timeMs: now() - started, pv: [move], exact: false, empties };
    }
    best.nodes = this.nodes;
    best.timeMs = now() - started;
    best.ttHits = this.ttHits;
    return best;
  }
}
