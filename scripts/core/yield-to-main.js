/**
 * Yield to the browser event loop so timers, Socket.IO heartbeats, and paints can run.
 * Prefer Chromium's scheduler.yield() when available; otherwise use a macrotask.
 *
 * @param {number} [minDelayMs=0] Minimum delay for setTimeout fallback (ms)
 * @returns {Promise<void>}
 */
export async function yieldToMain(minDelayMs = 0) {
  try {
    const sch = globalThis.scheduler;
    if (sch && typeof sch.yield === 'function') {
      await sch.yield();
      return;
    }
  } catch (_) {
    /* ignore */
  }
  await new Promise((resolve) => setTimeout(resolve, minDelayMs));
}
