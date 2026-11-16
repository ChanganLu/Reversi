/**
 * client.js — the main thread's handle on the AI worker.
 *
 * Wraps the message protocol in promises: `think()` resolves with the engine's
 * chosen move, `cancel()` abandons an in-flight search, and every request is
 * tagged with an id so that stale results can never move a piece.
 */

export const ENGINE_MCTS = 'mcts';
export const ENGINE_AB = 'ab';

export class AiClient {
  /**
   * @param {{onProgress?:Function, onError?:Function, onReady?:Function}} [handlers]
   */
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.nextId = 1;
    /** @type {Map<number, {resolve:Function, reject:Function}>} */
    this.pending = new Map();
    this.ready = false;
    this.supported = typeof Worker !== 'undefined';
    this.worker = null;

    if (!this.supported) {
      this.reportError(
        new Error(
          'This browser does not support Web Workers, so the search engine cannot run in the background.',
        ),
      );
      return;
    }

    try {
      this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch (error) {
      this.reportError(error);
      return;
    }

    this.worker.addEventListener('message', (event) => this.onMessage(event.data));
    this.worker.addEventListener('error', (event) => {
      this.reportError(event.error ?? new Error(event.message ?? 'The AI worker failed to start.'));
    });
  }

  /** @param {any} message */
  onMessage(message) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.handlers.onReady?.(message);
        break;
      case 'progress':
        this.handlers.onProgress?.(message.id, message.stats);
        break;
      case 'result': {
        const entry = this.pending.get(message.id);
        if (entry) {
          this.pending.delete(message.id);
          entry.resolve({ move: message.move, stats: message.stats, engine: message.engine });
        }
        break;
      }
      case 'error': {
        const entry = this.pending.get(message.id);
        if (entry) {
          this.pending.delete(message.id);
          entry.reject(new Error(message.message));
        } else {
          this.reportError(new Error(message.message));
        }
        break;
      }
      case 'info':
        break;
      default:
        break;
    }
  }

  reportError(error) {
    if (this.handlers.onError) this.handlers.onError(error);
    else console.error(error);
  }

  /** Switches engine. Any in-flight search is abandoned. */
  configure(engine, seed) {
    if (!this.worker) return;
    this.cancelAll();
    this.worker.postMessage({ type: 'config', engine, seed });
  }

  /** Drops cached search state (new game, undo, engine switch). */
  reset() {
    if (!this.worker) return;
    this.cancelAll();
    this.worker.postMessage({ type: 'reset' });
  }

  /**
   * Asks for a move.
   *
   * @param {object} request
   * @param {number[]} request.board 64 entries, 0 empty / 1 black / 2 white
   * @param {number} request.turn side to move
   * @param {number[]} [request.path] moves played since the previous search
   * @param {number} [request.timeMs]
   * @param {number} [request.maxDepth]
   * @param {number} [request.randomness]
   * @returns {Promise<{move:number|null, stats:object, engine:string}>}
   */
  think(request) {
    if (!this.worker) {
      return Promise.reject(new Error('The AI worker is unavailable in this browser.'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'think', id, ...request });
    });
  }

  /** Abandons the search with the given id (or every search when omitted). */
  cancel(id) {
    if (!this.worker) return;
    if (typeof id === 'number') {
      this.worker.postMessage({ type: 'cancel', id });
      const entry = this.pending.get(id);
      if (entry) {
        this.pending.delete(id);
        entry.reject(new Error('cancelled'));
      }
      return;
    }
    this.cancelAll();
  }

  cancelAll() {
    if (!this.worker) return;
    for (const [id, entry] of this.pending) {
      this.worker.postMessage({ type: 'cancel', id });
      entry.reject(new Error('cancelled'));
    }
    this.pending.clear();
  }

  terminate() {
    this.cancelAll();
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }
}
