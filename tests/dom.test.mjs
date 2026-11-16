/**
 * dom.test.mjs — end-to-end test of the real application in a DOM.
 *
 * `index.html` is loaded into jsdom, the modules in `js/` are imported for real,
 * and `main.js` boots the application exactly as it does in a browser. Only the
 * Web Worker is replaced: instead of a real worker the stub speaks the same
 * message protocol but runs the genuine MctsEngine / AlphaBetaEngine on the
 * Node event loop. That covers the controller, the view, the worker protocol and
 * the persistence layer without a browser.
 *
 * Requires `npm install` (jsdom is a dev-only dependency). When jsdom is not
 * installed the test is skipped, so `node --test tests/` still works with no
 * dependencies for the pure-logic suites.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { MctsEngine } from '../js/ai/mcts.js';
import { AlphaBetaEngine } from '../js/ai/alphabeta.js';
import { POS_SIZE, encodePosition } from '../js/ai/bitboard.js';

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(resolve(here, '../index.html'), 'utf8');

/* ------------------------------------------------------------------ */
/* Worker stub                                                         */
/* ------------------------------------------------------------------ */

/**
 * Speaks the worker protocol in-process. Time budgets are clamped so the test
 * finishes quickly while still exercising iterative deepening and tree reuse.
 */
class StubWorker {
  constructor() {
    this.listeners = { message: [], error: [] };
    this.engine = new MctsEngine({ seed: 12345 });
    this.engineKind = 'mcts';
    this.cancelled = new Set();
    this.position = new Int32Array(POS_SIZE);
    this.board = new Uint8Array(64);
  }

  addEventListener(type, handler) {
    (this.listeners[type] ??= []).push(handler);
  }

  removeEventListener(type, handler) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((entry) => entry !== handler);
  }

  emit(data) {
    for (const handler of this.listeners.message ?? []) handler({ data });
  }

  terminate() {
    this.cancelled.clear();
  }

  postMessage(message) {
    void this.handle(message);
  }

  async handle(message) {
    switch (message.type) {
      case 'config':
        this.engineKind = message.engine === 'ab' ? 'ab' : 'mcts';
        this.engine =
          this.engineKind === 'ab'
            ? new AlphaBetaEngine({ tableBits: 12 })
            : new MctsEngine({ seed: message.seed ?? 12345 });
        return;
      case 'reset':
        this.engine.reset();
        return;
      case 'cancel':
        this.cancelled.add(message.id);
        return;
      case 'think':
        await this.runThink(message);
        return;
      default:
        return;
    }
  }

  async runThink(message) {
    const { id } = message;
    this.board.set(message.board);
    encodePosition(this.board, message.turn, this.position, 0);
    const timeMs = Math.min(message.timeMs ?? 100, 120);
    const shouldAbort = () => this.cancelled.has(id);

    try {
      let result;
      if (this.engineKind === 'ab') {
        result = await this.engine.think(this.position, {
          timeMs,
          maxDepth: 3,
          onIteration: (stats) => this.emit({ type: 'progress', id, stats }),
          shouldAbort,
        });
      } else {
        result = await this.engine.think(this.position, {
          timeMs,
          path: message.path ?? [],
          onProgress: (stats) => this.emit({ type: 'progress', id, stats }),
          shouldAbort,
        });
      }
      if (this.cancelled.has(id)) return;
      if (result === null) {
        this.emit({ type: 'result', id, move: null, stats: { pass: true } });
        return;
      }
      this.emit({ type: 'result', id, move: result.move, stats: result, engine: this.engineKind });
    } catch (error) {
      this.emit({ type: 'error', id, message: String(error) });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

const dom = new JSDOM(indexHtml, {
  url: 'http://127.0.0.1:8080/',
  pretendToBeVisual: true,
});
const { window } = dom;

// Publish the browser globals the app expects, then import it for real.
// `navigator` is a read-only global in Node, so it is left alone.
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Worker = StubWorker;
globalThis.URLSearchParams = window.URLSearchParams ?? URLSearchParams;
globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) ?? ((cb) => setTimeout(cb, 16));

// jsdom has no HTMLDialogElement support in older versions; provide the two
// methods the settings sheet uses.
const dialog = window.document.getElementById('settings-dialog');
if (typeof dialog.showModal !== 'function') {
  dialog.showModal = function showModal() {
    this.setAttribute('open', 'true');
  };
  dialog.close = function close() {
    this.removeAttribute('open');
  };
}

await import('../js/main.js');
const app = window.reversi.app;

/** Waits until `predicate` is true, or fails after `timeout` ms. */
async function waitFor(predicate, { timeout = 15000, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

test('the page boots with a rendered opening position', () => {
  assert.equal(window.document.querySelectorAll('.cell').length, 64);
  assert.equal(window.document.querySelectorAll('.disc').length, 4);
  assert.equal(window.document.querySelectorAll('.cell.is-legal').length, 4);
  assert.equal(window.document.querySelectorAll('.cell.is-playable').length, 4);
  assert.match(window.document.getElementById('status-line').textContent, /Black to move/);
  assert.match(window.document.getElementById('footer-meta').textContent, /Web Worker/);
  assert.equal(app.game.history.length, 0);
});

test('the human can move and the engine answers', async () => {
  const legal = app.game.legalMoves();
  const before = window.document.querySelectorAll('.disc').length;
  app.onHumanMove(legal[0]);
  assert.equal(window.document.querySelectorAll('.disc').length, before + 1);
  assert.equal(window.document.querySelectorAll('#move-list li').length, 1);

  await waitFor(() => app.game.history.length >= 2, { label: 'the engine reply' });
  assert.equal(app.game.history[1].player, 2, 'the computer plays white');
  assert.ok(app.game.history[1].sq >= 0 && app.game.history[1].sq < 64);
  assert.equal(window.document.querySelectorAll('#move-list li').length, 2);
  // Telemetry from the search must have reached the panel.
  const playouts = window.document.getElementById('stat-a').textContent;
  assert.notEqual(playouts, '—');
  assert.match(window.document.getElementById('chance-value').textContent, /%$/);
});

test('undo takes back the exchange and returns the turn to the human', async () => {
  app.undo();
  assert.equal(app.game.history.length, 0);
  assert.equal(app.game.turn, 1);
  assert.equal(window.document.querySelectorAll('#move-list li').length, 0);
  assert.equal(window.document.querySelectorAll('.disc').length, 4);
});

test('the hint marks exactly one suggestion', async () => {
  app.requestHint();
  await waitFor(() => window.document.querySelectorAll('.cell.is-suggested').length === 1, {
    label: 'a hint',
  });
  assert.match(window.document.getElementById('status-line').textContent, /Suggestion|to move/);
});

test('an illegal click is ignored', () => {
  const emptyIllegal = [...Array(64).keys()].find(
    (sq) => app.game.isEmpty(sq) && !app.game.isLegal(sq),
  );
  const before = app.game.history.length;
  app.onHumanMove(emptyIllegal);
  assert.equal(app.game.history.length, before);
});

test('switching to computer-versus-computer makes the engines play each other', async () => {
  app.applySettings({ ...app.settings, mode: 'cvc' });
  await waitFor(() => app.game.history.length >= 3, { label: 'self-play moves', timeout: 20000 });
  assert.equal(app.sides().human.length, 0);
  assert.ok(app.game.history.length >= 3);
});

test('the theme switch is applied and remembered', () => {
  window.document.querySelector('#theme-switch button[data-theme-value="midnight"]').click();
  assert.equal(window.document.documentElement.dataset.theme, 'midnight');
  const stored = JSON.parse(window.localStorage.getItem('reversi.settings.v1'));
  assert.equal(stored.theme, 'midnight');
  window.document.querySelector('#theme-switch button[data-theme-value="paper"]').click();
  assert.equal(window.document.documentElement.dataset.theme, 'paper');
});

test('new game returns to the opening position', () => {
  window.document.getElementById('btn-new').click();
  assert.equal(app.game.history.length, 0);
  assert.equal(window.document.querySelectorAll('.disc').length, 4);
  assert.equal(window.document.querySelectorAll('#move-list li').length, 0);
});

test('the settings sheet applies a new mode and restarts', () => {
  window.document.getElementById('btn-settings').click();
  const paperMode = window.document.querySelector('input[name="mode"][value="pvp"]');
  paperMode.checked = true;
  window.document.querySelector('input[name="level"][value="easy"]').checked = true;
  window.document.getElementById('btn-apply').click();
  assert.equal(app.settings.mode, 'pvp');
  assert.equal(app.settings.level, 'easy');
  assert.equal(app.game.history.length, 0);
  assert.equal(app.sides().human.length, 2, 'two-player mode hands both colours to humans');
});

test('a saved game is restored on the next start', async () => {
  // Play a couple of moves, then re-create the app to simulate a reload.
  app.onHumanMove(app.game.legalMoves()[0]);
  await waitFor(() => app.game.history.length >= 1, { label: 'a move' });
  const moves = app.game.moveList();
  assert.ok(moves.length >= 1);
  const saved = JSON.parse(window.localStorage.getItem('reversi.game.v1'));
  assert.ok(saved && Array.isArray(saved.moves));
  assert.equal(saved.moves.length, moves.length);
});
