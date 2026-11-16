/**
 * storage.js — small, defensive helpers around localStorage.
 *
 * All access is wrapped in try/catch: private-mode browsers throw on write, and
 * a corrupt value must never stop the game from starting.
 */

const SETTINGS_KEY = 'reversi.settings.v1';
const GAME_KEY = 'reversi.game.v1';

/** @returns {Storage|null} */
function store() {
  try {
    const test = '__reversi_probe__';
    window.localStorage.setItem(test, '1');
    window.localStorage.removeItem(test);
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Reads a JSON value, returning `fallback` for anything unusable.
 * @template T
 * @param {string} key
 * @param {T} fallback
 * @returns {T}
 */
function readJSON(key, fallback) {
  const ls = store();
  if (!ls) return fallback;
  try {
    const raw = ls.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return fallback;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

/** @param {string} key @param {unknown} value */
function writeJSON(key, value) {
  const ls = store();
  if (!ls) return;
  try {
    ls.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or privacy mode: settings simply are not persisted */
  }
}

/** @param {string} key */
function remove(key) {
  const ls = store();
  if (!ls) return;
  try {
    ls.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS = {
  mode: 'pvc-black',
  engine: 'mcts',
  level: 'hard',
  theme: 'paper',
  showLegal: true,
  showCoords: false,
  animations: true,
};

/** @returns {typeof DEFAULT_SETTINGS} */
export function loadSettings() {
  const stored = readJSON(SETTINGS_KEY, DEFAULT_SETTINGS);
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  const modes = ['pvc-black', 'pvc-white', 'pvp', 'cvc'];
  if (!modes.includes(merged.mode)) merged.mode = DEFAULT_SETTINGS.mode;
  if (!['mcts', 'ab'].includes(merged.engine)) merged.engine = DEFAULT_SETTINGS.engine;
  if (!['easy', 'medium', 'hard', 'expert'].includes(merged.level)) merged.level = DEFAULT_SETTINGS.level;
  if (!['paper', 'midnight', 'felt'].includes(merged.theme)) merged.theme = DEFAULT_SETTINGS.theme;
  merged.showLegal = Boolean(merged.showLegal);
  merged.showCoords = Boolean(merged.showCoords);
  merged.animations = Boolean(merged.animations);
  return merged;
}

/** @param {typeof DEFAULT_SETTINGS} settings */
export function saveSettings(settings) {
  writeJSON(SETTINGS_KEY, settings);
}

/* ------------------------------------------------------------------ */
/* Saved game                                                          */
/* ------------------------------------------------------------------ */

/**
 * Persists the moves of the current game so a reload can resume it.
 * @param {{moves:number[], mode:string, engine:string, level:string}} snapshot
 */
export function saveGame(snapshot) {
  writeJSON(GAME_KEY, snapshot);
}

/** @returns {{moves:number[], mode:string, engine:string, level:string}|null} */
export function loadGame() {
  const stored = readJSON(GAME_KEY, null);
  if (!stored || !Array.isArray(stored.moves) || stored.moves.length === 0) return null;
  const moves = stored.moves.filter((sq) => Number.isInteger(sq) && sq >= 0 && sq < 64);
  if (moves.length === 0) return null;
  return {
    moves,
    mode: typeof stored.mode === 'string' ? stored.mode : DEFAULT_SETTINGS.mode,
    engine: typeof stored.engine === 'string' ? stored.engine : DEFAULT_SETTINGS.engine,
    level: typeof stored.level === 'string' ? stored.level : DEFAULT_SETTINGS.level,
  };
}

/** Forgets the saved game. */
export function clearGame() {
  remove(GAME_KEY);
}
