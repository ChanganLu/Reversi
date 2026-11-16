/**
 * panel.js — the right-hand column: score, engine telemetry and move history.
 *
 * Pure view code: it reads a game/config snapshot and writes the DOM. It is
 * deliberately dumb so the controller in main.js stays the single place where
 * game flow lives.
 */

import { toNotation } from '../game/rules.js';

const ENGINE_LABEL = {
  mcts: 'Monte-Carlo',
  ab: 'Deep search',
};

/**
 * Maps an alpha-beta score onto a rough win probability for display.
 * Clearly labelled as an estimate in the UI.
 */
export function scoreToChance(score) {
  if (!Number.isFinite(score)) return 0.5;
  // Proven results come back as huge terminal scores.
  if (Math.abs(score) > 400000) return score > 0 ? 1 : 0;
  return 1 / (1 + Math.exp(-score / 5000));
}

export class PanelView {
  /** @param {Document} [doc] */
  constructor(doc = document) {
    this.doc = doc;
    this.byId = (id) => doc.getElementById(id);

    this.black = this.byId('score-black');
    this.white = this.byId('score-white');
    this.blackCount = this.black.querySelector('[data-count]');
    this.whiteCount = this.white.querySelector('[data-count]');
    this.blackRole = this.black.querySelector('[data-role]');
    this.whiteRole = this.white.querySelector('[data-role]');
    this.scoreBar = this.byId('score-black').parentElement.querySelector('[data-bar]');

    this.statusLine = this.byId('status-line');
    this.statusHint = this.byId('status-hint');

    this.engineBadge = this.byId('engine-badge');
    this.thinking = this.byId('thinking');
    this.thinkingLabel = this.byId('thinking-label');
    this.statLabels = [this.byId('stat-a-label'), this.byId('stat-b-label'), this.byId('stat-c-label')];
    this.statValues = [this.byId('stat-a'), this.byId('stat-b'), this.byId('stat-c')];
    this.chanceValue = this.byId('chance-value');
    this.chanceFill = this.byId('chance-fill');
    this.chanceLabel = this.byId('chance-label');
    this.pvLine = this.byId('pv-line');

    this.moveList = this.byId('move-list');
    this.moveCount = this.byId('move-count');

    this.buttons = {
      newGame: this.byId('btn-new'),
      undo: this.byId('btn-undo'),
      hint: this.byId('btn-hint'),
      aiMove: this.byId('btn-ai-move'),
    };

    this.footerMeta = this.byId('footer-meta');
  }

  /**
   * Updates the scoreboard.
   * @param {{counts:{black:number, white:number}, turn:number, roles:{black:string, white:string},
   *          activeBlack:boolean, activeWhite:boolean}} state
   */
  updateScore(state) {
    this.blackCount.textContent = String(state.counts.black);
    this.whiteCount.textContent = String(state.counts.white);
    this.blackRole.textContent = state.roles.black;
    this.whiteRole.textContent = state.roles.white;
    this.black.classList.toggle('is-active', state.activeBlack);
    this.white.classList.toggle('is-active', state.activeWhite);
    const total = Math.max(1, state.counts.black + state.counts.white);
    this.scoreBar.style.width = `${(state.counts.black / total) * 100}%`;
  }

  /** @param {string} line @param {string} hint @param {'neutral'|'win'|'lose'} [tone] */
  setStatus(line, hint, tone = 'neutral') {
    this.statusLine.textContent = line;
    this.statusLine.dataset.tone = tone;
    this.statusHint.textContent = hint;
  }

  /** @param {boolean} active @param {string} [label] */
  setThinking(active, label = 'Thinking…') {
    this.thinking.hidden = !active;
    this.thinkingLabel.textContent = label;
  }

  /** @param {string} engine */
  setEngine(engine) {
    this.engineBadge.textContent = ENGINE_LABEL[engine] ?? engine;
    if (engine === 'ab') {
      this.statLabels[0].textContent = 'Depth';
      this.chanceLabel.textContent = 'Estimated win chance';
    } else {
      this.statLabels[0].textContent = 'Playouts';
      this.chanceLabel.textContent = 'Estimated win chance';
    }
  }

  /** Clears the telemetry (used on a new game). */
  resetStats() {
    for (const value of this.statValues) value.textContent = '—';
    this.chanceValue.textContent = '—';
    this.chanceFill.style.width = '0%';
    this.pvLine.hidden = true;
  }

  /**
   * Renders search telemetry.
   * @param {object|null} stats
   * @param {string} engine
   * @param {number} engineColor side the statistics belong to
   */
  updateStats(stats, engine, engineColor) {
    if (!stats) {
      this.resetStats();
      return;
    }
    const sideName = engineColor === 1 ? 'Black' : 'White';
    if (engine === 'ab') {
      this.statLabels[0].textContent = 'Depth';
      this.statValues[0].textContent = stats.depth ? String(stats.depth) : '—';
    } else {
      this.statLabels[0].textContent = 'Playouts';
      this.statValues[0].textContent = formatCount(stats.iterations);
    }
    this.statValues[1].textContent = formatCount(stats.nodes ?? stats.rootVisits);
    this.statValues[2].textContent = stats.timeMs === undefined ? '—' : formatTime(stats.timeMs);

    let chance = null;
    if (engine === 'mcts' && typeof stats.bestValue === 'number') chance = stats.bestValue;
    else if (engine === 'ab' && typeof stats.score === 'number') chance = scoreToChance(stats.score);
    if (chance === null) {
      this.chanceValue.textContent = '—';
      this.chanceFill.style.width = '0%';
    } else {
      const percent = Math.round(chance * 100);
      this.chanceValue.textContent = `${percent}%`;
      this.chanceFill.style.width = `${Math.max(2, Math.min(100, percent))}%`;
      this.chanceLabel.textContent = `Estimated win chance · ${sideName}`;
    }

    const pv = Array.isArray(stats.pv) ? stats.pv : [];
    if (pv.length > 0) {
      this.pvLine.hidden = false;
      this.pvLine.innerHTML = `<strong>Line:</strong> ${pv
        .slice(0, 8)
        .map((sq) => toNotation(sq))
        .join(' · ')}`;
    } else if (typeof stats.rootVisits === 'number') {
      this.pvLine.hidden = false;
      this.pvLine.innerHTML = `<strong>Root visits:</strong> ${formatCount(stats.rootVisits)}${
        stats.reused ? ' · tree reused' : ''
      }`;
    } else {
      this.pvLine.hidden = true;
    }
  }

  /**
   * Renders the move history as a compact grid.
   * @param {{moves:{sq:number, player:number}[], currentIndex:number}} state
   */
  renderMoves(state) {
    const moves = state.moves;
    this.moveCount.textContent = String(moves.length);
    if (moves.length === 0) {
      this.moveList.textContent = '';
      return;
    }
    const fragment = this.doc.createDocumentFragment();
    moves.forEach((move, index) => {
      const li = this.doc.createElement('li');
      li.className = move.player === 1 ? 'is-black' : 'is-white';
      if (index === state.currentIndex) li.classList.add('is-current');
      const number = this.doc.createElement('span');
      number.className = 'index';
      number.textContent = String(index + 1);
      const name = this.doc.createElement('span');
      name.className = move.player === 1 ? 'ply-black' : 'ply-white';
      name.textContent = toNotation(move.sq);
      li.appendChild(number);
      li.appendChild(name);
      fragment.appendChild(li);
    });
    this.moveList.textContent = '';
    this.moveList.appendChild(fragment);
    // Keep the newest move in view.
    this.moveList.scrollTop = this.moveList.scrollHeight;
  }

  /**
   * Enables/disables the action buttons.
   * @param {{undo:boolean, hint:boolean, aiMove:boolean, newGame:boolean}} state
   */
  setButtonState(state) {
    this.buttons.undo.disabled = !state.undo;
    this.buttons.hint.disabled = !state.hint;
    this.buttons.aiMove.disabled = !state.aiMove;
    this.buttons.newGame.disabled = !state.newGame;
  }

  /** @param {string} text */
  setFooter(text) {
    this.footerMeta.textContent = text;
  }
}

function formatCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  return String(Math.round(value));
}

function formatTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}
