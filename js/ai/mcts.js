/**
 * mcts.js — the Monte-Carlo Tree Search engine.
 *
 * A UCT implementation tuned for Reversi:
 *
 *  - **Tree reuse.** The tree survives between moves. After the opponent
 *    replies, `advance()` walks the existing tree to the new position and keeps
 *    every visit that is still relevant, so each move starts with a head start.
 *  - **Single-perspective backup.** Every node stores the score from the point
 *    of view of the searching player, which keeps the selection rule simple:
 *    maximising nodes pick the highest UCB, minimising nodes the lowest.
 *  - **Forced passes are folded in.** A position where the opponent cannot reply
 *    is modelled as the same player moving twice, exactly as the rules work;
 *    terminal positions carry their exact disc result.
 *  - **Heuristic rollouts.** Random playouts are extremely noisy in Reversi, so
 *    playouts are truncated after a few random moves and scored with the shared
 *    evaluator. That is both cheaper and far less variance-prone than playing
 *    the position out to the end.
 *
 * Positions are `[ownLo, ownHi, oppLo, oppHi]` bitboards relative to the player
 * to move, exactly as in bitboard.js.
 */

import { POS_SIZE, applyMove, moveMask, popcount64 } from './bitboard.js';
import { evaluate } from './evaluate.js';
import { now, yieldToEventLoop } from './yield.js';

/**
 * UCT exploration constant, applied to values in [0, 1]. Tuned by self-play
 * (tools/arena.mjs, see the README): a low value exploits good moves quickly,
 * which suits Reversi's small branching factor.
 */
export const DEFAULT_EXPLORATION = 0.25;

/** Corner bits: a8, h8 in the low word; a1, h1 in the high word. */
const CORNER_LO = (1 << 0) | (1 << 7);
const CORNER_HI = (1 << 24) | (1 << 31);

/** Value of a drawn position, on the [0, 1] scale. */
const DRAW_VALUE = 0.5;

class MctsNode {
  /**
   * @param {number} move square index, or -1 for the root
   * @param {MctsNode|null} parent
   * @param {boolean} maximizing true when the searching player is to move here
   */
  constructor(move, parent, maximizing) {
    this.move = move;
    this.parent = parent;
    /** @type {MctsNode[]|null} */
    this.children = null;
    /** Legal moves at this position (Uint8Array); null for a terminal node. */
    this.moves = null;
    this.moveCount = 0;
    /** How many children have been created so far. */
    this.expanded = 0;
    this.visits = 0;
    /** Sum of the searching player's scores, each in [0, 1]. */
    this.wins = 0;
    this.maximizing = maximizing;
    /** True when the same player moves again (the opponent had to pass). */
    this.pass = false;
    /** Terminal nodes carry their exact value for the searching player. */
    this.terminal = false;
    this.terminalValue = 0;
  }

  /** Mean score of this node for the searching player. */
  get value() {
    return this.visits === 0 ? DRAW_VALUE : this.wins / this.visits;
  }
}

export class MctsEngine {
  constructor(config = {}) {
    this.exploration = config.exploration ?? DEFAULT_EXPLORATION;
    /** Hard cap on tree size, to keep memory bounded. */
    this.maxNodes = config.maxNodes ?? 400000;
    /** Defensive cap: a game cannot exceed 60 moves. */
    this.maxPlayoutSteps = 90;
    /** Random moves played before handing over to the static evaluator. */
    this.cutoffPlies = config.cutoffPlies ?? 5;
    /** Scale mapping a static evaluation onto the [-1, 1] playout value. */
    this.evalScale = config.evalScale ?? 3500;

    /** @type {MctsNode|null} */
    this.root = null;
    this.nodeCount = 0;

    // Scratch state for the descent and the playouts (no per-node allocation).
    this.buf = new Int32Array(POS_SIZE);
    this.nextBuf = new Int32Array(POS_SIZE);
    this.playBuf = new Int32Array(POS_SIZE);
    this.maskBuf = new Int32Array(2);
    this.ownIsAi = true;

    this.rootLo = 0;
    this.rootHi = 0;
    this.rootOppLo = 0;
    this.rootOppHi = 0;

    /** Playouts performed during the current think() call. */
    this.iterations = 0;
    this.randomState = config.seed ?? 0x9e3779b9;
  }

  /* ---------------------------------------------------------------- */
  /* Random numbers                                                    */
  /* ---------------------------------------------------------------- */

  /** xorshift32: fast, deterministic and good enough for rollouts. */
  nextRandom() {
    let x = this.randomState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.randomState = x | 0;
    return (x >>> 0) / 4294967296;
  }

  /* ---------------------------------------------------------------- */
  /* Tree management                                                   */
  /* ---------------------------------------------------------------- */

  /** Discards the search tree. */
  reset() {
    this.root = null;
    this.nodeCount = 0;
    this.iterations = 0;
  }

  /**
   * Walks the existing tree along `path` (the moves played since the previous
   * search) and promotes the deepest matching node to the root.
   *
   * @param {number[]} path
   * @returns {MctsNode|null}
   */
  advance(path) {
    if (!this.root || !Array.isArray(path) || path.length === 0) return this.root;
    let node = this.root;
    for (const move of path) {
      if (!node.children) break;
      let next = null;
      for (const child of node.children) {
        if (child.move === move) {
          next = child;
          break;
        }
      }
      if (!next) break;
      node = next;
    }
    if (node === this.root) return this.root;
    node.parent = null;
    this.root = node;
    this.recountNodes();
    return this.root;
  }

  /** Recomputes the node count after pruning. */
  recountNodes() {
    let count = 0;
    const stack = [this.root];
    while (stack.length > 0) {
      const node = stack.pop();
      count++;
      if (node.children) {
        for (const child of node.children) stack.push(child);
      }
    }
    this.nodeCount = count;
  }

  /* ---------------------------------------------------------------- */
  /* Search                                                            */
  /* ---------------------------------------------------------------- */

  /** Fills `node.moves` with the legal moves of the position in `this.buf`. */
  prepareNode(node) {
    const count = moveMask(this.buf[0], this.buf[1], this.buf[2], this.buf[3], this.maskBuf);
    node.moveCount = count;
    node.expanded = 0;
    if (count === 0) {
      node.moves = null;
      return 0;
    }
    const moves = new Uint8Array(count);
    let index = 0;
    let word = this.maskBuf[0];
    while (word !== 0) {
      const bit = word & -word;
      moves[index++] = 31 - Math.clz32(bit);
      word ^= bit;
    }
    word = this.maskBuf[1];
    while (word !== 0) {
      const bit = word & -word;
      moves[index++] = 32 + 31 - Math.clz32(bit);
      word ^= bit;
    }
    node.moves = moves;
    return count;
  }

  /**
   * Selects a child of a fully expanded node with the UCT rule.
   * The searching player maximises its score, the opponent minimises it.
   */
  selectChild(node) {
    const children = node.children;
    const logParent = Math.log(node.visits + 1);
    const maximizing = node.maximizing;
    let best = children[0];
    let bestScore = -Infinity;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const mean = child.visits === 0 ? DRAW_VALUE : child.wins / child.visits;
      const exploitation = maximizing ? mean : 1 - mean;
      const exploration = this.exploration * Math.sqrt(logParent / (child.visits + 1));
      const score = exploitation + exploration;
      if (score > bestScore) {
        bestScore = score;
        best = child;
      }
    }
    return best;
  }

  /** Applies `child.move` to the current buffer and keeps the mover flag in step. */
  applyChild(child) {
    const buf = this.buf;
    applyMove(buf[0], buf[1], buf[2], buf[3], child.move, this.nextBuf, 0);
    if (child.pass) {
      // The opponent could not move, so the same player continues: swap back to
      // keep "own" on the side that is about to move.
      this.buf[0] = this.nextBuf[2];
      this.buf[1] = this.nextBuf[3];
      this.buf[2] = this.nextBuf[0];
      this.buf[3] = this.nextBuf[1];
    } else {
      this.buf[0] = this.nextBuf[0];
      this.buf[1] = this.nextBuf[1];
      this.buf[2] = this.nextBuf[2];
      this.buf[3] = this.nextBuf[3];
      this.ownIsAi = !this.ownIsAi;
    }
  }

  /**
   * Creates one child of `node` by playing its next untried move, leaving the
   * child's position in `this.buf`.
   * @returns {MctsNode|null} null when the node budget is exhausted
   */
  expand(node) {
    if (this.nodeCount >= this.maxNodes) return null;
    const move = node.moves[node.expanded++];
    const buf = this.buf;
    applyMove(buf[0], buf[1], buf[2], buf[3], move, this.nextBuf, 0);

    const child = new MctsNode(move, node, node.maximizing);

    // nextBuf is expressed for the opponent of the mover.
    const opponentMoves = moveMask(
      this.nextBuf[0],
      this.nextBuf[1],
      this.nextBuf[2],
      this.nextBuf[3],
      this.maskBuf,
    );
    let moverMoves = -1;
    if (opponentMoves === 0) {
      // The opponent is stuck: either the mover plays again or the game ends.
      moverMoves = moveMask(this.nextBuf[2], this.nextBuf[3], this.nextBuf[0], this.nextBuf[1], this.maskBuf);
    }

    if (opponentMoves > 0) {
      child.pass = false;
      child.maximizing = !node.maximizing;
      this.buf[0] = this.nextBuf[0];
      this.buf[1] = this.nextBuf[1];
      this.buf[2] = this.nextBuf[2];
      this.buf[3] = this.nextBuf[3];
      this.ownIsAi = !this.ownIsAi;
      this.prepareNode(child);
    } else if (moverMoves > 0) {
      // Forced pass: the mover continues after the side swap.
      child.pass = true;
      child.maximizing = node.maximizing;
      this.buf[0] = this.nextBuf[2];
      this.buf[1] = this.nextBuf[3];
      this.buf[2] = this.nextBuf[0];
      this.buf[3] = this.nextBuf[1];
      this.prepareNode(child);
    } else {
      // Both players are stuck: the game is over.
      child.pass = false;
      child.maximizing = !node.maximizing;
      child.terminal = true;
      const moverDiff =
        popcount64(this.nextBuf[2], this.nextBuf[3]) - popcount64(this.nextBuf[0], this.nextBuf[1]);
      const aiDiff = this.ownIsAi ? moverDiff : -moverDiff;
      child.terminalValue = aiDiff > 0 ? 1 : aiDiff < 0 ? 0 : DRAW_VALUE;
      child.moves = null;
      child.moveCount = 0;
    }

    if (node.children === null) node.children = [];
    node.children.push(child);
    this.nodeCount++;
    return child;
  }

  /**
   * Plays a (possibly truncated) random game from the position in `this.buf`.
   * @returns {number} position value in [-1, 1] for the player to move
   */
  playout() {
    let mLo = this.buf[0];
    let mHi = this.buf[1];
    let oLo = this.buf[2];
    let oHi = this.buf[3];
    // `sign` follows the perspective of the buffer: it flips every time the
    // side owning `mLo/mHi` changes, i.e. after every move and every pass.
    let sign = 1;
    let passes = 0;

    for (let step = 0; step < this.maxPlayoutSteps; step++) {
      if (this.cutoffPlies > 0 && step >= this.cutoffPlies) {
        // Hand over to the static evaluator: a far lower-variance estimate than
        // playing the position out to the end with random moves.
        let scaled = evaluate(mLo, mHi, oLo, oHi) / this.evalScale;
        if (scaled > 1) scaled = 1;
        else if (scaled < -1) scaled = -1;
        return sign * scaled;
      }

      const count = moveMask(mLo, mHi, oLo, oHi, this.maskBuf);
      if (count === 0) {
        if (++passes >= 2) break;
        let swap = mLo;
        mLo = oLo;
        oLo = swap;
        swap = mHi;
        mHi = oHi;
        oHi = swap;
        sign = -sign;
        continue;
      }
      passes = 0;

      let move;
      const cornerLo = this.maskBuf[0] & CORNER_LO;
      const cornerHi = this.maskBuf[1] & CORNER_HI;
      if ((cornerLo | cornerHi) !== 0) {
        // Taking a free corner is almost always right and steers the random
        // playout away from pure noise.
        if (cornerLo !== 0) move = 31 - Math.clz32(cornerLo & -cornerLo);
        else move = 32 + 31 - Math.clz32(cornerHi & -cornerHi);
      } else {
        const pick = (this.nextRandom() * count) | 0;
        let word = this.maskBuf[0];
        const lowBits = popcount64(word, 0);
        if (pick < lowBits) {
          let remaining = pick;
          while (remaining-- > 0) word &= word - 1;
          move = 31 - Math.clz32(word & -word);
        } else {
          word = this.maskBuf[1];
          let remaining = pick - lowBits;
          while (remaining-- > 0) word &= word - 1;
          move = 32 + 31 - Math.clz32(word & -word);
        }
      }

      applyMove(mLo, mHi, oLo, oHi, move, this.playBuf, 0);
      mLo = this.playBuf[0];
      mHi = this.playBuf[1];
      oLo = this.playBuf[2];
      oHi = this.playBuf[3];
      sign = -sign;
    }

    // The playout reached the end of the game: the result is exact.
    const diff = popcount64(mLo, mHi) - popcount64(oLo, oHi);
    return sign * (diff > 0 ? 1 : diff < 0 ? -1 : 0);
  }

  /** Runs one selection / expansion / simulation / backup cycle. */
  iterate() {
    // --- selection ----------------------------------------------------
    let node = this.root;
    this.buf[0] = this.rootLo;
    this.buf[1] = this.rootHi;
    this.buf[2] = this.rootOppLo;
    this.buf[3] = this.rootOppHi;
    this.ownIsAi = true;

    while (!node.terminal && node.children !== null && node.expanded >= node.moveCount) {
      node = this.selectChild(node);
      this.applyChild(node);
    }

    // --- expansion ----------------------------------------------------
    if (!node.terminal && node.moves !== null && node.expanded < node.moveCount) {
      const child = this.expand(node);
      // A null child means the node budget is exhausted: roll out from `node`.
      if (child !== null) node = child;
    }

    // --- simulation ---------------------------------------------------
    let value;
    if (node.terminal) {
      value = node.terminalValue;
    } else {
      const playoutValue = this.playout();
      const aiValue = this.ownIsAi ? playoutValue : -playoutValue;
      value = (aiValue + 1) / 2;
    }

    // --- backup -------------------------------------------------------
    this.iterations++;
    let current = node;
    while (current !== null) {
      current.visits++;
      current.wins += value;
      current = current.parent;
    }
  }

  /** Aggregated root statistics. */
  statistics(startedAt) {
    const root = this.root;
    const children = root.children ?? [];
    let best = null;
    for (const child of children) {
      if (best === null || child.visits > best.visits) best = child;
    }
    return {
      iterations: this.iterations,
      nodes: this.nodeCount,
      timeMs: now() - startedAt,
      rootVisits: root.visits,
      bestMove: best ? best.move : null,
      bestValue: best ? best.value : DRAW_VALUE,
      bestVisits: best ? best.visits : 0,
      children: children
        .map((child) => ({ move: child.move, visits: child.visits, value: child.value }))
        .sort((a, b) => b.visits - a.visits),
    };
  }

  /**
   * Searches for the best move.
   *
   * @param {Int32Array} position `[ownLo, ownHi, oppLo, oppHi]`, searcher to move
   * @param {object} [options]
   * @param {number} [options.timeMs] thinking time budget
   * @param {number[]} [options.path] moves played since the previous search
   * @param {(info:object)=>void} [options.onProgress] periodic progress callback
   * @param {()=>boolean} [options.shouldAbort] polled between chunks
   * @returns {Promise<object|null>} null when the searcher has no legal move
   */
  async think(position, options = {}) {
    const timeMs = options.timeMs ?? 1000;
    const path = options.path;
    const onProgress = options.onProgress;
    const shouldAbort = options.shouldAbort;

    this.rootLo = position[0];
    this.rootHi = position[1];
    this.rootOppLo = position[2];
    this.rootOppHi = position[3];
    this.iterations = 0;

    let reused = false;
    if (this.root !== null && Array.isArray(path) && path.length > 0) {
      this.advance(path);
      if (this.root.moves !== null && this.root.visits > 0 && this.root.moveCount > 0) {
        // Guard against a stale subtree: the reused root must describe exactly
        // the position we are about to search, so its move list must match.
        const count = moveMask(this.rootLo, this.rootHi, this.rootOppLo, this.rootOppHi, this.maskBuf);
        reused = count === this.root.moveCount;
      }
    }
    if (!reused) {
      this.reset();
      this.buf[0] = this.rootLo;
      this.buf[1] = this.rootHi;
      this.buf[2] = this.rootOppLo;
      this.buf[3] = this.rootOppHi;
      const root = new MctsNode(-1, null, true);
      if (this.prepareNode(root) === 0) return null; // no legal move: the caller passes
      this.root = root;
      this.nodeCount = 1;
    }

    const started = now();
    const deadline = started + timeMs;
    let lastReport = started;

    while (true) {
      // Work in small chunks so cancellation requests are seen promptly.
      const chunkEnd = Math.min(deadline, now() + 12);
      while (now() < chunkEnd) {
        this.iterate();
        this.iterate();
        this.iterate();
        this.iterate();
      }
      const stamp = now();
      if (onProgress && stamp - lastReport > 80) {
        lastReport = stamp;
        onProgress(this.statistics(started));
      }
      if (stamp >= deadline) break;
      await yieldToEventLoop();
      if (shouldAbort && shouldAbort()) break;
    }

    const stats = this.statistics(started);
    if (stats.bestMove === null) {
      // Nothing was searched (tiny budget): play the first legal move.
      this.buf[0] = this.rootLo;
      this.buf[1] = this.rootHi;
      this.buf[2] = this.rootOppLo;
      this.buf[3] = this.rootOppHi;
      const count = this.prepareNode(this.root);
      if (count === 0) return null;
      const fallback = this.root.moves[0];
      return { ...stats, move: fallback, bestMove: fallback, reused };
    }
    return { ...stats, move: stats.bestMove, reused };
  }
}
