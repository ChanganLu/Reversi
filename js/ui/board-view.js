/**
 * board-view.js — everything that draws the board and nothing that decides it.
 *
 * The view owns the 64 cells, the disc elements, hover/keyboard affordances and
 * the flip animation. It is told what the position is; it never mutates it.
 */

import { EMPTY, toNotation } from '../game/rules.js';

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const RANKS = ['8', '7', '6', '5', '4', '3', '2', '1'];
/** Decorative star points, as on a Go board. */
const STAR_SQUARES = new Set([18, 21, 42, 45]);

export class BoardView {
  /**
   * @param {HTMLElement} root the `.board` element
   * @param {{onPlay:(sq:number)=>void, onHover?:(sq:number|null)=>void}} handlers
   */
  constructor(root, handlers = {}) {
    this.root = root;
    this.handlers = handlers;
    /** @type {HTMLDivElement[]} */
    this.cells = [];
    /** Colour currently shown on each square (0 = empty). @type {Uint8Array} */
    this.rendered = new Uint8Array(64);
    this.focusIndex = 19;
    this.showLegal = true;
    this.showCoords = true;
    this.animations = true;
    this.interactive = false;
    this.legalMoves = new Set();
    this.build();
  }

  /** Creates the cells and the coordinate gutters. */
  build() {
    this.root.textContent = '';
    this.cells = [];
    this.rendered = new Uint8Array(64);
    const fragment = document.createDocumentFragment();
    for (let sq = 0; sq < 64; sq++) {
      // Cells are buttons: they get keyboard activation, focus handling and the
      // right role for screen readers for free.
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      cell.dataset.sq = String(sq);
      cell.setAttribute('aria-label', toNotation(sq));
      cell.tabIndex = sq === this.focusIndex ? 0 : -1;
      if (STAR_SQUARES.has(sq)) {
        const star = document.createElement('i');
        star.className = 'star';
        star.setAttribute('aria-hidden', 'true');
        cell.appendChild(star);
      }

      cell.addEventListener('click', () => this.onCellActivated(sq));
      cell.addEventListener('mouseenter', () => this.handlers.onHover?.(sq));
      cell.addEventListener('mouseleave', () => this.handlers.onHover?.(null));
      this.cells.push(cell);
      fragment.appendChild(cell);
    }
    this.root.appendChild(fragment);
    this.root.addEventListener('keydown', (event) => this.onKeyDown(event));
    this.buildCoordinates();
  }

  /**
   * Removes every disc without rebuilding the grid. `render` then re-creates
   * them with the entry animation, which is exactly what a new game needs.
   */
  resetVisuals() {
    for (let sq = 0; sq < 64; sq++) {
      const disc = this.cells[sq].querySelector('.disc');
      if (disc) disc.remove();
      const marker = this.cells[sq].querySelector('.move-marker');
      if (marker) marker.remove();
      this.cells[sq].classList.remove('is-last', 'is-legal', 'is-playable', 'is-suggested');
    }
    this.rendered.fill(0);
    this.legalMoves = new Set();
  }

  /** Coordinate gutters live beside the grid inside the board shell. */
  buildCoordinates() {
    const shell = this.root.closest('.board-shell');
    if (!shell) return;
    this.shell = shell;
    if (!this.filesEl) {
      this.filesEl = document.createElement('div');
      this.filesEl.className = 'board-coords board-coords--files';
      this.ranksEl = document.createElement('div');
      this.ranksEl.className = 'board-coords board-coords--ranks';
      for (const file of FILES) {
        const span = document.createElement('span');
        span.textContent = file;
        this.filesEl.appendChild(span);
      }
      for (const rank of RANKS) {
        const span = document.createElement('span');
        span.textContent = rank;
        this.ranksEl.appendChild(span);
      }
      shell.appendChild(this.filesEl);
      shell.appendChild(this.ranksEl);
    }
    this.setCoordinatesVisible(this.showCoords);
  }

  /** @param {boolean} visible */
  setCoordinatesVisible(visible) {
    this.showCoords = visible;
    if (this.shell) this.shell.dataset.coords = String(visible);
    if (this.filesEl) this.filesEl.hidden = !visible;
    if (this.ranksEl) this.ranksEl.hidden = !visible;
  }

  /** @param {boolean} enabled */
  setAnimations(enabled) {
    this.animations = enabled;
    this.root.dataset.motion = String(enabled);
  }

  /** @param {boolean} enabled */
  setShowLegal(enabled) {
    this.showLegal = enabled;
    this.root.dataset.showLegal = String(enabled);
  }

  /**
   * Paints a full position.
   *
   * @param {Uint8Array} board
   * @param {{legal?:number[], lastMove?:number, hint?:number|null, nextColor?:number,
   *          interactive?:boolean}} state
   */
  render(board, state = {}) {
    const legal = new Set(state.legal ?? []);
    this.legalMoves = legal;

    for (let sq = 0; sq < 64; sq++) {
      const cell = this.cells[sq];
      const value = board[sq];

      // --- disc creation / flipping -----------------------------------
      const current = this.rendered[sq];
      if (value !== current) {
        if (value === EMPTY) {
          const existing = cell.querySelector('.disc');
          if (existing) existing.remove();
        } else if (current === EMPTY) {
          cell.appendChild(this.createDisc(value));
        } else {
          const disc = cell.querySelector('.disc');
          if (disc) this.flipDisc(disc, value);
        }
        this.rendered[sq] = value;
      }

      // --- affordances -------------------------------------------------
      const playable = Boolean(state.interactive) && legal.has(sq);
      cell.classList.toggle('is-legal', legal.has(sq));
      cell.classList.toggle('is-playable', playable);
      cell.classList.toggle('is-last', sq === state.lastMove);
      cell.classList.toggle('is-suggested', sq === state.hint);
      cell.setAttribute('aria-label', this.describeSquare(sq, value, legal.has(sq), state.interactive));

      if (sq === state.lastMove) {
        if (!cell.querySelector('.move-marker')) {
          const marker = document.createElement('span');
          marker.className = 'move-marker';
          cell.appendChild(marker);
        }
      } else {
        const marker = cell.querySelector('.move-marker');
        if (marker) marker.remove();
      }
    }

    this.root.style.setProperty(
      '--preview-color',
      state.nextColor === 1 ? 'rgba(20,20,20,0.9)' : 'rgba(255,255,255,0.95)',
    );
    this.interactive = Boolean(state.interactive);
  }

  /** Screen-reader description of a square. */
  describeSquare(sq, value, legal, interactive) {
    const name = toNotation(sq);
    if (value === 1) return `${name}, black disc`;
    if (value === 2) return `${name}, white disc`;
    if (legal) return interactive ? `${name}, legal move` : `${name}, empty, legal move`;
    return `${name}, empty`;
  }

  /** @returns {HTMLDivElement} a fresh, unflipped disc showing `color`. */
  createDisc(color) {
    const disc = document.createElement('div');
    disc.className = 'disc is-new';
    const front = document.createElement('span');
    front.className = `face face-a ${color === 1 ? 'is-black' : 'is-white'}`;
    const back = document.createElement('span');
    back.className = `face face-b ${color === 1 ? 'is-white' : 'is-black'}`;
    disc.appendChild(front);
    disc.appendChild(back);
    disc.dataset.color = String(color);
    if (this.animations) {
      // Drop the class once the entry animation has played so a later flip is
      // driven by the transform transition instead of the keyframes.
      disc.addEventListener('animationend', () => disc.classList.remove('is-new'), { once: true });
    } else {
      disc.classList.remove('is-new');
    }
    return disc;
  }

  /**
   * Rotates a disc to show `color`. The hidden face is repainted first, so the
   * transition never flashes the old colour.
   */
  flipDisc(disc, color) {
    const flipped = disc.classList.contains('is-flipped');
    const hiddenFace = disc.querySelector(flipped ? '.face-a' : '.face-b');
    if (hiddenFace) {
      hiddenFace.classList.toggle('is-black', color === 1);
      hiddenFace.classList.toggle('is-white', color === 2);
    }
    if (this.animations) {
      disc.classList.toggle('is-flipped', !flipped);
    } else {
      // No animation: paint this face directly and keep the rotation neutral.
      disc.classList.remove('is-flipped');
      const visible = disc.querySelector('.face-a');
      if (visible) {
        visible.classList.toggle('is-black', color === 1);
        visible.classList.toggle('is-white', color === 2);
      }
      const back = disc.querySelector('.face-b');
      if (back) {
        back.classList.toggle('is-black', color === 2);
        back.classList.toggle('is-white', color === 1);
      }
    }
    disc.dataset.color = String(color);
  }

  /* ---------------------------------------------------------------- */
  /* Input                                                             */
  /* ---------------------------------------------------------------- */

  onCellActivated(sq) {
    if (!this.interactive) return;
    if (!this.legalMoves.has(sq)) return;
    this.focusIndex = sq;
    this.handlers.onPlay?.(sq);
  }

  /** Arrow keys move the cursor, Enter/Space plays. */
  onKeyDown(event) {
    const key = event.key;
    let next = null;
    const row = Math.floor(this.focusIndex / 8);
    const col = this.focusIndex % 8;
    if (key === 'ArrowUp' || key === 'w' || key === 'W') next = row > 0 ? this.focusIndex - 8 : this.focusIndex;
    else if (key === 'ArrowDown' || key === 's' || key === 'S') next = row < 7 ? this.focusIndex + 8 : this.focusIndex;
    else if (key === 'ArrowLeft' || key === 'a' || key === 'A') next = col > 0 ? this.focusIndex - 1 : this.focusIndex;
    else if (key === 'ArrowRight' || key === 'd' || key === 'D') next = col < 7 ? this.focusIndex + 1 : this.focusIndex;
    else if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      this.onCellActivated(this.focusIndex);
      return;
    } else if (key === 'Home') next = 0;
    else if (key === 'End') next = 63;
    else return;

    if (next === null) return;
    event.preventDefault();
    this.focusCell(next);
  }

  /** Moves the roving tabindex and the DOM focus to `sq`. */
  focusCell(sq) {
    this.cells[this.focusIndex].tabIndex = -1;
    this.focusIndex = sq;
    const cell = this.cells[sq];
    cell.tabIndex = 0;
    cell.focus({ preventScroll: true });
  }

  /** Focuses the first legal move (used when a turn starts). */
  focusFirstLegal() {
    for (const sq of this.legalMoves) {
      this.focusCell(sq);
      return;
    }
  }

  /** True when keyboard focus is currently inside the board. */
  hasFocus() {
    return this.root.contains(document.activeElement);
  }
}
