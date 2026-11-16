/**
 * main.js — application controller.
 *
 * Owns the game model, drives the AI worker and keeps the views in sync. All
 * game-state mutations go through `GameState`; all rendering goes through the
 * views; nothing here implements rules.
 */

import { BLACK, WHITE, toNotation } from './game/rules.js';
import { GameState } from './game/game-state.js';
import { BoardView } from './ui/board-view.js';
import { PanelView } from './ui/panel.js';
import { SettingsDialog } from './ui/settings.js';
import { AiClient } from './ai/client.js';
import * as storage from './util/storage.js';

/**
 * Difficulty presets. Time budgets are per move; `randomness` is the chance the
 * engine deliberately plays a random legal move, which is what makes "Easy"
 * genuinely easy without crippling the search itself.
 */
const LEVELS = {
  easy: {
    mcts: { timeMs: 200, randomness: 0.22 },
    ab: { timeMs: 150, maxDepth: 2, randomness: 0.22 },
  },
  medium: {
    mcts: { timeMs: 600, randomness: 0 },
    ab: { timeMs: 400, maxDepth: 4, randomness: 0 },
  },
  hard: {
    mcts: { timeMs: 1500, randomness: 0 },
    ab: { timeMs: 1200, maxDepth: 8, randomness: 0 },
  },
  expert: {
    mcts: { timeMs: 3500, randomness: 0 },
    ab: { timeMs: 2500, maxDepth: 16, randomness: 0 },
  },
};

const MODES = {
  'pvc-black': { human: [BLACK], ai: [WHITE] },
  'pvc-white': { human: [WHITE], ai: [BLACK] },
  pvp: { human: [BLACK, WHITE], ai: [] },
  cvc: { human: [], ai: [BLACK, WHITE] },
};

class App {
  constructor() {
    this.settings = storage.loadSettings();
    this.game = new GameState();
    this.panel = new PanelView();
    this.board = new BoardView(document.getElementById('board'), {
      onPlay: (sq) => this.onHumanMove(sq),
    });

    /** Invalidates in-flight searches when the game changes underneath them. */
    this.requestToken = 0;
    this.thinking = false;
    this.hint = null;
    this.stats = null;
    this.statsColor = BLACK;
    /** Index into the move list at the time of the last search (tree reuse). */
    this.lastSearchIndex = 0;
    this.aiAvailable = true;

    this.ai = new AiClient({
      onReady: () => {
        this.aiAvailable = true;
        this.updateFooter();
      },
      onProgress: (id, stats) => {
        if (id !== this.activeRequestId) return;
        this.stats = stats;
        this.panel.updateStats(stats, this.settings.engine, this.statsColor);
      },
      onError: (error) => this.onAiError(error),
    });

    this.settingsDialog = new SettingsDialog({
      getSettings: () => this.settings,
      onApply: (settings) => this.applySettings(settings),
      onResume: () => this.resumeSavedGame(),
      canResume: () => storage.loadGame() !== null,
    });

    this.bindControls();
    this.applyVisualSettings();
  }

  /** Pushes the theme and board options from settings into the views. */
  applyVisualSettings() {
    this.board.setShowLegal(this.settings.showLegal);
    this.board.setCoordinatesVisible(this.settings.showCoords);
    this.board.setAnimations(this.settings.animations);
    this.panel.setEngine(this.settings.engine);
    this.applyTheme(this.settings.theme, { persist: false });
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */

  bindControls() {
    document.getElementById('btn-settings').addEventListener('click', () => this.settingsDialog.open());
    this.panel.buttons.newGame.addEventListener('click', () => this.newGame());
    this.panel.buttons.undo.addEventListener('click', () => this.undo());
    this.panel.buttons.hint.addEventListener('click', () => this.requestHint());
    this.panel.buttons.aiMove.addEventListener('click', () => this.playForHuman());

    for (const button of document.querySelectorAll('#theme-switch button')) {
      button.addEventListener('click', () => this.applyTheme(button.dataset.themeValue));
    }

    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) {
        return;
      }
      if (document.getElementById('settings-dialog').open) return;
      const key = event.key.toLowerCase();
      if (key === 'h') {
        event.preventDefault();
        this.requestHint();
      } else if (key === 'u') {
        event.preventDefault();
        this.undo();
      } else if (key === 'n') {
        event.preventDefault();
        this.newGame();
      }
    });
  }

  /**
   * Starts the game loop: apply URL overrides, restore a saved game, or begin a
   * new one.
   *
   * Query parameters (`?theme=felt&mode=cvc&engine=ab&level=expert&demo=24`)
   * make the page deep-linkable and give the screenshot tool a deterministic
   * position to capture.
   */
  start() {
    const params = new URLSearchParams(window.location.search);
    this.settings = applyUrlOverrides(this.settings, params);
    this.applyVisualSettings();
    this.ai.configure(this.settings.engine, randomSeed());

    const demoPlies = Math.min(58, Math.max(0, Number(params.get('demo') ?? 0) || 0));
    if (demoPlies > 0) {
      playDemoMoves(this.game, demoPlies);
      this.resumedFromSave = false;
      this.refreshUi();
      this.afterTurnStart();
      return;
    }

    const saved = storage.loadGame();
    if (saved) {
      this.settings = { ...this.settings, mode: saved.mode, engine: saved.engine, level: saved.level };
      this.settings = applyUrlOverrides(this.settings, params);
      this.ai.configure(this.settings.engine, randomSeed());
      this.game.loadMoves(saved.moves);
      this.applyVisualSettings();
      this.resumedFromSave = true;
    }
    this.refreshUi();
    this.afterTurnStart();
  }

  /* ---------------------------------------------------------------- */
  /* Game flow                                                         */
  /* ---------------------------------------------------------------- */

  /** Which sides the human controls, according to the current mode. */
  sides() {
    return MODES[this.settings.mode] ?? MODES['pvc-black'];
  }

  isHumanSide(color) {
    return this.sides().human.includes(color);
  }

  isAiSide(color) {
    return this.aiAvailable && this.sides().ai.includes(color);
  }

  isHumanTurn() {
    return !this.game.over && this.isHumanSide(this.game.turn);
  }

  isAiTurn() {
    return !this.game.over && this.isAiSide(this.game.turn);
  }

  newGame({ keepStats = false } = {}) {
    this.cancelSearch();
    this.game.reset();
    this.hint = null;
    this.stats = null;
    this.statsColor = BLACK;
    this.lastSearchIndex = 0;
    this.resumedFromSave = false;
    storage.clearGame();
    this.ai.reset();
    this.board.resetVisuals();
    if (!keepStats) this.panel.resetStats();
    this.refreshUi();
    this.afterTurnStart();
  }

  /** Called whenever it becomes someone's turn. */
  afterTurnStart() {
    if (this.game.over) {
      this.announceResult();
      return;
    }
    this.refreshUi();
    if (this.isAiTurn()) this.requestAiMove();
  }

  /** @param {number} sq */
  onHumanMove(sq) {
    if (this.thinking || !this.isHumanTurn()) return;
    if (!this.game.isLegal(sq)) return;
    this.hint = null;
    const result = this.game.play(sq);
    if (result.status !== 'ok') return;
    this.persist();
    this.refreshUi();
    this.afterTurnStart();
  }

  /**
   * Asks the engine for a move on behalf of the side to move.
   * @param {{assist?: boolean}} [options] assist = play it even though a human owns that side
   */
  async requestAiMove({ assist = false } = {}) {
    if (this.game.over) return;
    if (!assist && !this.isAiTurn()) return;
    if (!this.aiAvailable) {
      this.panel.setStatus('Engine unavailable', 'The AI could not start in this browser. Reload the page to retry.');
      return;
    }

    const side = this.game.turn;
    const token = ++this.requestToken;
    this.statsColor = side;
    this.thinking = true;
    this.panel.setThinking(true, assist ? 'Finding your best move…' : 'Thinking…');
    this.refreshUi({ keepStatus: true });
    this.panel.setStatus(
      this.game.over ? 'Game over' : `${side === BLACK ? 'Black' : 'White'} is thinking…`,
      'The search runs in a Web Worker, so the interface stays responsive.',
    );

    const preset = LEVELS[this.settings.level][this.settings.engine];
    const request = {
      board: Array.from(this.game.board),
      turn: side,
      timeMs: preset.timeMs,
      maxDepth: preset.maxDepth,
      randomness: preset.randomness ?? 0,
      path: this.game.moveList().slice(this.lastSearchIndex),
    };

    this.activeRequestId = this.ai.nextId;
    let result;
    try {
      result = await this.ai.think(request);
    } catch (error) {
      if (token !== this.requestToken) return; // superseded or cancelled
      this.thinking = false;
      this.panel.setThinking(false);
      this.onAiError(error);
      return;
    }
    if (token !== this.requestToken) return; // a newer request owns the board
    this.thinking = false;
    this.panel.setThinking(false);

    if (result.move === null || result.move === undefined) {
      // The engine has no legal move: pass and hand over.
      this.panel.setStatus(
        `${side === BLACK ? 'Black' : 'White'} must pass`,
        'Neither side could move, so the game ended or the turn changed.',
      );
      this.afterTurnStart();
      return;
    }

    this.stats = result.stats;
    this.statsColor = side;
    this.panel.updateStats(result.stats, this.settings.engine, side);
    this.lastSearchIndex = this.game.history.length;
    const played = this.game.play(result.move);
    if (played.status !== 'ok') {
      this.onAiError(new Error(`The engine returned an illegal move (${result.move}).`));
      return;
    }
    this.hint = null;
    this.persist();
    this.refreshUi();
    this.afterTurnStart();
  }

  /** Plays the current position for whichever side a human controls. */
  playForHuman() {
    if (this.thinking || this.game.over) return;
    if (!this.isHumanTurn()) return;
    if (!this.aiAvailable) {
      this.panel.setStatus('Engine unavailable', 'The AI could not start in this browser.');
      return;
    }
    this.requestAiMove({ assist: true });
  }

  /** Suggests a move for the human without playing it. */
  async requestHint() {
    if (this.thinking || !this.isHumanTurn() || !this.aiAvailable) return;
    const side = this.game.turn;
    const token = ++this.requestToken;
    this.thinking = true;
    this.panel.setThinking(true, 'Looking for a move…');
    this.refreshUi({ keepStatus: true });
    this.panel.setStatus('Hint in progress…', 'A short search for your side.');

    const preset = LEVELS[this.settings.level][this.settings.engine];
    try {
      const result = await this.ai.think({
        board: Array.from(this.game.board),
        turn: side,
        timeMs: Math.min(900, Math.max(300, preset.timeMs)),
        maxDepth: preset.maxDepth,
        randomness: 0,
        path: this.game.moveList().slice(this.lastSearchIndex),
      });
      if (token !== this.requestToken) return;
      this.thinking = false;
      this.panel.setThinking(false);
      if (result.move === null) return;
      this.hint = result.move;
      this.stats = result.stats;
      this.statsColor = side;
      this.panel.updateStats(result.stats, this.settings.engine, side);
      this.refreshUi();
      this.panel.setStatus(
        `Suggestion: ${toNotation(result.move)}`,
        'Press H again for another look, or click the square to play it.',
      );
    } catch (error) {
      if (token !== this.requestToken) return;
      this.thinking = false;
      this.panel.setThinking(false);
      this.onAiError(error);
    }
  }

  /** Takes back moves until the human is on move again. */
  undo() {
    if (!this.game.canUndo()) return;
    this.cancelSearch();
    this.hint = null;
    const humansPresent = this.sides().human.length > 0;

    this.game.undo(1);
    // With a human involved, take back the reply as well so the same player
    // gets to move again.
    if (humansPresent && !this.game.over && this.isAiSide(this.game.turn) && this.game.canUndo()) {
      this.game.undo(1);
    }
    this.lastSearchIndex = 0;
    this.ai.reset();
    this.persist();
    this.refreshUi();
    if (this.game.over || this.isAiTurn()) {
      // A computer-to-computer game simply continues.
      this.afterTurnStart();
    }
  }

  /** Cancels any running search and invalidates its result. */
  cancelSearch() {
    this.requestToken++;
    this.activeRequestId = -1;
    if (this.ai) this.ai.cancelAll();
    this.thinking = false;
    this.panel.setThinking(false);
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  refreshUi({ keepStatus = false } = {}) {
    const counts = this.game.counts();
    const legal = this.game.over ? [] : this.game.moves;
    const interactive = this.isHumanTurn() && !this.thinking;

    this.board.render(this.game.board, {
      legal,
      lastMove: this.game.history.length > 0 ? this.game.lastMove : -1,
      hint: this.hint,
      nextColor: this.game.turn,
      interactive,
    });

    const roles = {
      black: this.isHumanSide(BLACK) ? (this.settings.mode === 'pvp' ? 'Player 1' : 'You') : 'Computer',
      white: this.isHumanSide(WHITE) ? (this.settings.mode === 'pvp' ? 'Player 2' : 'You') : 'Computer',
    };
    if (this.settings.mode === 'cvc') {
      roles.black = 'Computer';
      roles.white = 'Computer';
    }

    this.panel.updateScore({
      counts,
      turn: this.game.turn,
      roles,
      activeBlack: !this.game.over && this.game.turn === BLACK,
      activeWhite: !this.game.over && this.game.turn === WHITE,
    });

    this.panel.renderMoves({
      moves: this.game.history,
      currentIndex: this.game.history.length - 1,
    });

    this.panel.setButtonState({
      undo: this.game.canUndo(),
      hint: this.isHumanTurn() && !this.thinking && this.aiAvailable,
      aiMove: this.isHumanTurn() && !this.thinking && this.aiAvailable,
      newGame: true,
    });

    if (!keepStatus && !this.thinking) this.updateStatus(roles);
    this.updateFooter();
  }

  /** @param {{black:string, white:string}} roles */
  updateStatus(roles) {
    if (this.game.over) {
      this.panel.setStatus(...this.resultText());
      return;
    }
    const sideName = this.game.turn === BLACK ? 'Black' : 'White';
    const role = this.game.turn === BLACK ? roles.black : roles.white;
    const turnText = `${sideName} to move`;
    let hint = '';
    if (this.game.passed) hint = `${sideName === 'Black' ? 'White' : 'Black'} had no legal move and passed. `;
    if (role === 'You' || role.startsWith('Player')) {
      hint += this.resumedFromSave
        ? 'Resumed from your last session — press New game to start over.'
        : `You play ${sideName.toLowerCase()}. Click a highlighted square or use the arrow keys and Enter.`;
    } else {
      hint += 'The engine is choosing a move.';
    }
    this.panel.setStatus(turnText, hint);
  }

  /** @returns {[string, string, 'win'|'lose'|'neutral']} */
  resultText() {
    const counts = this.game.counts();
    const winner = this.game.winner();
    if (winner === 0) {
      return [`Draw ${counts.black}–${counts.white}`, 'Both sides finished with the same number of discs.', 'neutral'];
    }
    const sideName = winner === BLACK ? 'Black' : 'White';
    const summary = `${sideName} wins ${counts.black}–${counts.white}`;
    const humanWon = this.isHumanSide(winner);
    const anyHuman = this.sides().human.length > 0;
    if (!anyHuman) return [summary, 'Computer against computer. Press New game to watch another.', 'neutral'];
    return [
      summary,
      humanWon ? 'You won. Press N for a rematch.' : 'The engine won. Press N for a rematch.',
      humanWon ? 'win' : 'lose',
    ];
  }

  announceResult() {
    const [line, hint, tone] = this.resultText();
    this.panel.setStatus(line, hint, tone);
    this.panel.setThinking(false);
  }

  updateFooter() {
    const preset = LEVELS[this.settings.level][this.settings.engine];
    const engineName = this.settings.engine === 'ab' ? 'alpha-beta' : 'MCTS';
    const budget = preset.timeMs >= 1000 ? `${(preset.timeMs / 1000).toFixed(1)} s` : `${preset.timeMs} ms`;
    const workerState = this.aiAvailable ? 'Web Worker' : 'engine unavailable';
    this.panel.setFooter(`AI: ${engineName} · ${this.settings.level} · ${budget}/move · ${workerState}`);
  }

  /* ---------------------------------------------------------------- */
  /* Settings, theme, persistence                                      */
  /* ---------------------------------------------------------------- */

  applySettings(next) {
    const themeChanged = next.theme !== this.settings.theme;
    const engineChanged = next.engine !== this.settings.engine;
    const modeChanged = next.mode !== this.settings.mode;
    this.settings = { ...next };
    storage.saveSettings(this.settings);

    this.board.setShowLegal(this.settings.showLegal);
    this.board.setCoordinatesVisible(this.settings.showCoords);
    this.board.setAnimations(this.settings.animations);
    this.panel.setEngine(this.settings.engine);
    this.applyTheme(this.settings.theme, { persist: false });
    if (themeChanged) storage.saveSettings(this.settings);
    if (engineChanged) {
      this.ai.configure(this.settings.engine, randomSeed());
      this.panel.resetStats();
    }
    this.newGame();
    if (modeChanged) this.updateFooter();
  }

  /** @param {string} theme @param {{persist?:boolean}} [options] */
  applyTheme(theme, { persist = true } = {}) {
    const value = ['paper', 'midnight', 'felt'].includes(theme) ? theme : 'paper';
    document.documentElement.dataset.theme = value;
    this.settings.theme = value;
    for (const button of document.querySelectorAll('#theme-switch button')) {
      const active = button.dataset.themeValue === value;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    if (persist) storage.saveSettings(this.settings);
  }

  resumeSavedGame() {
    const saved = storage.loadGame();
    if (!saved) return;
    this.cancelSearch();
    this.settings = { ...this.settings, mode: saved.mode, engine: saved.engine, level: saved.level };
    this.game = new GameState();
    this.game.loadMoves(saved.moves);
    this.lastSearchIndex = 0;
    this.ai.reset();
    this.ai.configure(this.settings.engine, randomSeed());
    this.panel.setEngine(this.settings.engine);
    this.resumedFromSave = true;
    this.refreshUi();
    this.afterTurnStart();
  }

  persist() {
    storage.saveGame({
      moves: this.game.moveList(),
      mode: this.settings.mode,
      engine: this.settings.engine,
      level: this.settings.level,
    });
  }

  onAiError(error) {
    this.thinking = false;
    this.panel.setThinking(false);
    const message = error && error.message ? error.message : String(error);
    if (message === 'cancelled') return;
    this.aiAvailable = false;
    this.panel.setStatus('Engine error', `${message} Reload the page to try again.`, 'lose');
    this.updateFooter();
    this.refreshUi({ keepStatus: true });
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

/** A fresh seed for the MCTS playout stream. */
function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

/**
 * Applies `?theme=`, `?mode=`, `?engine=` and `?level=` overrides.
 * @param {object} settings
 * @param {URLSearchParams} params
 */
function applyUrlOverrides(settings, params) {
  const next = { ...settings };
  const theme = params.get('theme');
  const mode = params.get('mode');
  const engine = params.get('engine');
  const level = params.get('level');
  if (['paper', 'midnight', 'felt'].includes(theme)) next.theme = theme;
  if (['pvc-black', 'pvc-white', 'pvp', 'cvc'].includes(mode)) next.mode = mode;
  if (['mcts', 'ab'].includes(engine)) next.engine = engine;
  if (['easy', 'medium', 'hard', 'expert'].includes(level)) next.level = level;
  return next;
}

/**
 * Fills the board with `plies` deterministic pseudo-random moves so a demo or a
 * screenshot shows a real mid-game position instead of the opening.
 * @param {GameState} game
 * @param {number} plies
 */
function playDemoMoves(game, plies) {
  let state = 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  for (let i = 0; i < plies; i++) {
    const moves = game.legalMoves();
    if (moves.length === 0) break;
    const move = moves[Math.floor(next() * moves.length)];
    if (game.play(move).status !== 'ok') break;
  }
}

const app = new App();
app.start();

// A tiny handle for debugging from the console.
window.reversi = {
  app,
  newGame: () => app.newGame(),
  state: () => ({ turn: app.game.turn, moves: app.game.notationList(), over: app.game.over }),
};
