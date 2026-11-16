/**
 * yield.js — cooperative yielding for the worker.
 *
 * The search loops are synchronous, which means a Web Worker cannot react to
 * incoming messages (including a cancel request) until the loop returns. The
 * engines therefore await `yieldToEventLoop()` between iterations, which drains
 * the message queue in well under a millisecond.
 *
 * Node gets `setImmediate` (no extra handle keeps the process alive); browsers
 * and workers get a MessageChannel round-trip, which is far cheaper than the
 * ~4 ms floor that nested `setTimeout(0)` calls are clamped to.
 */

const useImmediate = typeof setImmediate === 'function';

let channel = null;
let pending = null;

function channelYield() {
  if (channel === null) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => {
      const resolve = pending;
      pending = null;
      if (resolve) resolve();
    };
  }
  return new Promise((resolve) => {
    pending = resolve;
    channel.port2.postMessage(0);
  });
}

/** Resolves on the next macrotask, letting queued messages run first. */
export function yieldToEventLoop() {
  if (useImmediate) {
    return new Promise((resolve) => setImmediate(resolve));
  }
  if (typeof MessageChannel === 'undefined') {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return channelYield();
}

/** Monotonic clock that works in browsers, workers and Node. */
export const now =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();
