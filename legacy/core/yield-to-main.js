/**
 * Resolve once the document is visible. If already visible, resolves on the
 * next microtask. Otherwise waits for a `visibilitychange` that reveals it.
 * @returns {Promise<void>}
 * @private
 */
function _waitForVisible() {
  return new Promise((resolve) => {
    try {
      if (typeof document === 'undefined' || !document.hidden) { resolve(); return; }
    } catch (_) { resolve(); return; }
    let settled = false;
    const done = () => {
      if (settled) return;
      let hidden = false;
      try { hidden = !!document.hidden; } catch (_) { hidden = false; }
      if (hidden) return;
      settled = true;
      try { document.removeEventListener('visibilitychange', done); } catch (_) {}
      resolve();
    };
    try {
      document.addEventListener('visibilitychange', done);
    } catch (_) {
      // No event support — fail open rather than hang forever.
      resolve();
    }
  });
}

/**
 * Whether a scene load is currently in progress (best-effort global check).
 * @returns {boolean}
 * @private
 */
function _isSceneLoading() {
  try {
    return globalThis.window?.MapShine?.__msaSceneLoading === true;
  } catch (_) {
    return false;
  }
}

/**
 * Yield to the browser event loop so timers, Socket.IO heartbeats, and paints can run.
 * Prefer Chromium's scheduler.yield() when available; otherwise use a macrotask.
 *
 * LOAD-PHASE VISIBILITY HOLD: if a scene is loading AND the tab is hidden, this
 * pauses at the yield boundary until the tab is visible again. Background tabs
 * throttle setTimeout to >=1s and stop requestAnimationFrame, which stretches
 * the load's carefully-paced per-chunk GPU work far past the ~2s GPU
 * driver-watchdog (TDR) threshold — the "tab out during load -> WebGL context
 * lost" crash. Holding here means the heavy chunk simply doesn't run while
 * hidden; it resumes cleanly on return. Gated on `__msaSceneLoading` so runtime
 * (post-load) yields are NEVER blocked, and fails open (resolves) if document/
 * events are unavailable so it can never hang the load permanently.
 *
 * @param {number} [minDelayMs=0] Minimum delay for setTimeout fallback (ms)
 * @returns {Promise<void>}
 */
export async function yieldToMain(minDelayMs = 0) {
  try {
    const sch = globalThis.scheduler;
    if (sch && typeof sch.yield === 'function') {
      await sch.yield();
    } else {
      await new Promise((resolve) => setTimeout(resolve, minDelayMs));
    }
  } catch (_) {
    await new Promise((resolve) => setTimeout(resolve, minDelayMs));
  }

  try {
    if (_isSceneLoading() && typeof document !== 'undefined' && document.hidden) {
      await _waitForVisible();
    }
  } catch (_) {
    /* fail open */
  }
}
