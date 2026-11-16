/**
 * game-state.js — the authoritative, UI-facing game model.
 *
 * The model owns the board, whose turn it is, and the move history. It is the
 * only place that mutates game state; both the human and the AI go through
 * `play()`, so rules (including forced passes) can never diverge between them.
 */

import {
  BLACK,
  EMPTY,
  PASS,
  RAY_SQUARES,
  RAY_START,
  SQUARE_COUNT,
  WHITE,
  countDiscs,
  createBoard,
  generateMoves,
  initialBoard,
  isLegalMoveFast,
  toNotation,
} from './rules.js';

/** Outcome codes returned by play(). */
export const PLAY_OK = 'ok';
export const PLAY_ILLEGAL = 'illegal';
export const PLAY_GAME_OVER = 'over';

export class GameState {
  constructor() {
    /** @type {Uint8Array} */
    this.board = createBoard();
    /** @type {number} BLACK or WHITE */
    this.turn = BLACK;
    /** @type {{sq:number, player:number, flipped:number[]}[]} */
    this.history = [];
    /** Square indices of the legal moves for the side to move. @type {number[]} */
    this.moves = [];
    /** True once neither side can move. */
    this.over = false;
    /** True when the side to move plays twice in a row (opponent had to pass). */
    this.passed = false;
    /** Squares that changed during the most recent move (for animations). */
    this.lastFlipped = [];
    /** Last played square, or PASS. */
    this.lastMove = PASS;
    this._scratch = new Uint8Array(SQUARE_COUNT);
    this.reset();
  }

  /** Starts a fresh standard game. */
  reset() {
    this.board = initialBoard();
    this.turn = BLACK;
    this.history = [];
    this.passed = false;
    this.lastFlipped = [];
    this.lastMove = PASS;
    this.refresh();
    return this;
  }

  /** Recomputes derived state (legal moves, game-over flag). */
  refresh() {
    const list = new Uint8Array(SQUARE_COUNT);
    const count = generateMoves(this.board, this.turn, list);
    this.moves = Array.from(list.subarray(0, count));
    const opponentCanMove = generateMoves(this.board, this.turn ^ 3, this._scratch) > 0;
    this.over = count === 0 && !opponentCanMove;
    return this;
  }

  /** Disc counts. */
  counts() {
    return countDiscs(this.board);
  }

  /** Number of empty squares. */
  emptyCount() {
    return countDiscs(this.board).empty;
  }

  /** @returns {boolean} true when `sq` is a legal move for the side to move. */
  isLegal(sq) {
    return !this.over && isLegalMoveFast(this.board, sq, this.turn, this.turn ^ 3);
  }

  /** Legal moves of the side to move. */
  legalMoves() {
    return this.moves.slice();
  }

  /** True when `sq` is empty. */
  isEmpty(sq) {
    return this.board[sq] === EMPTY;
  }

  /**
   * Plays `sq` for the side to move.
   * @param {number} sq
   * @returns {{status:string, flipped:number[], player:number, next:number, over:boolean, passed:boolean}}
   */
  play(sq) {
    if (this.over) {
      return { status: PLAY_GAME_OVER, flipped: [], player: this.turn, next: this.turn, over: true, passed: false };
    }
    if (!this.isLegal(sq)) {
      return { status: PLAY_ILLEGAL, flipped: [], player: this.turn, next: this.turn, over: false, passed: false };
    }
    const entry = this._apply(sq);
    return {
      status: PLAY_OK,
      flipped: entry.flipped,
      player: entry.player,
      next: this.turn,
      over: this.over,
      passed: this.passed,
    };
  }

  /**
   * Applies a validated move and updates turn / pass / game-over state.
   * @returns {{sq:number, player:number, flipped:number[]}} the history entry.
   */
  _apply(sq) {
    const player = this.turn;
    const opponent = player ^ 3;
    const flipped = collectFlips(this.board, sq, player, opponent);
    this.board[sq] = player;
    for (const target of flipped) this.board[target] = player;

    const entry = { sq, player, flipped };
    this.history.push(entry);
    this.lastMove = sq;
    this.lastFlipped = flipped;

    const opponentCanMove = generateMoves(this.board, opponent, this._scratch) > 0;
    if (opponentCanMove) {
      this.turn = opponent;
      this.passed = false;
    } else if (generateMoves(this.board, player, this._scratch) > 0) {
      // The opponent must pass: same player moves again.
      this.turn = player;
      this.passed = true;
    } else {
      this.turn = opponent;
      this.passed = false;
    }
    this.refresh();
    return entry;
  }

  /**
   * Takes back the last `count` moves (default 1) by replaying what remains.
   * Replaying is cheap and keeps pass handling provably identical to live play.
   */
  undo(count = 1) {
    const keep = Math.max(0, this.history.length - Math.max(1, count));
    const moves = this.history.slice(0, keep).map((entry) => entry.sq);
    this.loadMoves(moves);
    return this;
  }

  /** @returns {boolean} true when at least one move can be taken back. */
  canUndo() {
    return this.history.length > 0;
  }

  /**
   * Replaces the position with the sequence `moveList`.
   * Stops silently at the first illegal move so corrupted saves cannot throw.
   */
  loadMoves(moveList) {
    this.board = initialBoard();
    this.turn = BLACK;
    this.history = [];
    this.passed = false;
    this.over = false;
    this.lastMove = PASS;
    this.lastFlipped = [];
    this.refresh();

    for (const sq of moveList) {
      if (!Number.isInteger(sq) || sq < 0 || sq > 63) break;
      if (!this.isLegal(sq)) break;
      this._apply(sq);
      if (this.over) break;
    }
    return this;
  }

  /** Move history as square indices. */
  moveList() {
    return this.history.map((entry) => entry.sq);
  }

  /** "d3" style list of every move played. */
  notationList() {
    return this.history.map((entry) => toNotation(entry.sq));
  }

  /** Winner: BLACK, WHITE, 0 for a draw, or null while the game continues. */
  winner() {
    if (!this.over) return null;
    const { black, white } = countDiscs(this.board);
    if (black > white) return BLACK;
    if (white > black) return WHITE;
    return 0;
  }

  /** Compact serialisable snapshot (settings live outside this object). */
  toJSON() {
    return { moves: this.moveList() };
  }

  /** Restores from toJSON() output; tolerant of malformed input. */
  static fromJSON(data) {
    const game = new GameState();
    const moves = data && Array.isArray(data.moves) ? data.moves : [];
    game.loadMoves(moves);
    return game;
  }
}

/**
 * Collects the disc indices flipped by playing `me` on `sq`.
 * @returns {number[]}
 */
function collectFlips(board, sq, me, opp) {
  const flipped = [];
  const base = sq << 3;
  for (let d = 0; d < 8; d++) {
    const key = base + d;
    const start = RAY_START[key];
    const end = RAY_START[key + 1];
    let count = 0;
    for (let i = start; i < end; i++) {
      const value = board[RAY_SQUARES[i]];
      if (value === opp) {
        count++;
        continue;
      }
      if (value === me && count > 0) {
        for (let k = 0; k < count; k++) flipped.push(RAY_SQUARES[start + k]);
      }
      break;
    }
  }
  return flipped;
}

export { BLACK, WHITE, EMPTY, PASS };
