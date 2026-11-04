/**
 * FRAME PACER (2026-11-04) — present on every Nth display refresh, never on an
 * uneven mix of them.
 *
 * WHY. On a display faster than MSA can draw (measured: Big Bank, 144 Hz, effects
 * on or off), frames take 1, 2 or 3 refreshes in no pattern — rAF intervals of
 * 7 / 14 / 21 ms, spread ±4-5 ms around a 12-16 ms mean. Each frame's camera is
 * the camera AT ITS START, but how long it then stays on screen varies 3:1, so a
 * pan that is perfectly even in world space lands on the screen in uneven steps:
 * the eye tracks the motion and sees it stutter. Still frames hide this; moving
 * ones show it.
 *
 * WHAT. Choose a divisor N so that a frame reliably fits in N refreshes, then
 * draw only on every Nth one. 144 Hz with ~12-16 ms frames -> N = 2 -> a steady
 * 72 fps: each frame on screen for exactly two refreshes. Fewer frames, all the
 * same length, which is what smooth motion needs.
 *
 * HOW (no clock of its own — it only ever sees frame timestamps):
 * - `decide(t)` with the frame's rAF timestamp, from EVERY renderer that draws this
 *   frame. The first caller decides; later callers with the same `t` get the same
 *   answer, so Foundry's own canvas (tokens, doors, walls) and MSA's map are always
 *   drawn on the same frames and can never slide against each other.
 * - The refresh period is the shortest rAF interval seen lately (skipped frames are
 *   nearly free, so with pacing on rAF still ticks every refresh).
 * - A presented frame's COST, in refreshes, is how many refreshes pass before the
 *   next tick arrives (the main thread was busy until then). `auto` sets N to the
 *   90th percentile of recent costs: up quickly when frames overrun, down only
 *   when nearly every frame would have fitted in N-1.
 * - mode 'off' presents every frame (today's behaviour) but still learns the
 *   period and costs, so switching on starts from a measured divisor.
 */

export const PACER_MAX_DIVISOR = 4;
/** Presented frames remembered for the divisor decision. */
export const PACER_COST_WINDOW = 90;
/** rAF intervals remembered for the refresh estimate. */
export const PACER_DELTA_WINDOW = 120;
/**
 * Drawn frames between refresh re-probes while pacing. The period is learned from
 * the interval right AFTER a skipped tick (a skipped frame is free, so that interval
 * is exactly one refresh); frames that exactly fill their slot never leave one, so
 * the pacer makes one now and then (a single frame shown one refresh longer).
 */
export const PACER_REPROBE_AFTER = 600;
/** Presented frames a divisor must hold before a lower one is tried. */
export const PACER_LOWER_AFTER = 240;
/**
 * Presented frames a lower divisor that FAILED (raised straight back) is not tried
 * again for (~75 s at 48 fps). Paced frames look cheap because pacing gives the GPU
 * slack — measured on Big Bank at 144 Hz: costs read 1-2 refreshes at divisor 3,
 * yet divisor 2 overran 40% of frames — so the cost alone cannot say a lower
 * divisor will hold; only trying it can, and a failed try is a burst of stutter.
 */
export const PACER_RETRY_AFTER = 3600;
/** ...and before it may be raised again (a burst of overruns, not one hitch). */
export const PACER_RAISE_AFTER = 20;

const quantile = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/**
 * @param {{mode?: 'off'|'auto'|number}} [opts] - a number is a fixed divisor (1..4)
 */
export function createFramePacer({ mode = 'off' } = {}) {
  let _mode = mode;
  let refreshMs = null;
  const deltas = [];
  /** intervals that followed a skipped tick: exactly one refresh each */
  const postSkipDeltas = [];
  let drawnSinceSkip = 0;
  /** Recent drawn-frame costs in ms (converted to refreshes when read: the period may be relearned). */
  const costsMs = [];
  let prevT = null;
  let lastT = null;
  let lastDecision = true;
  let lastPresentT = null;
  let pendingCostFrom = null;
  let lastCostMs = null;
  let divisor = 1;
  let sinceChange = 0;
  let lastWasLower = false;
  /** the divisor that failed (and any below it) is not tried again before this presented count */
  let blockLowerUntil = 0;
  let blockedDivisor = 0;
  let presented = 0;
  let skipped = 0;
  // REFRESH PROBE. A machine whose every frame takes 3 refreshes never shows rAF a
  // 1-refresh interval, so the refresh it learns is 3x too long and every frame
  // looks like it costs "1". Switching pacing on therefore skips the tick right
  // after a few drawn frames: a skipped frame is free, so the next tick is exactly
  // one refresh later and the true period is seen.
  let probeSkips = 0;
  /** auto: unpaced costs to seed the divisor from once the probe has run */
  let seedCostsMs = null;

  const toRefreshes = (ms) => Math.max(1, Math.round(ms / refreshMs));
  const costsK = () => (refreshMs ? costsMs.map(toRefreshes) : []);

  function learnRefresh(t) {
    if (prevT !== null) {
      const d = t - prevT;
      // Ignore same-frame repeats and long stalls (a backgrounded tab, a hitch).
      if (d > 2 && d < 100) {
        if (lastDecision === false) {
          postSkipDeltas.push(d);
          if (postSkipDeltas.length > 30) postSkipDeltas.shift();
        } else {
          deltas.push(d);
          if (deltas.length > PACER_DELTA_WINDOW) deltas.shift();
        }
        // Prefer the exact post-skip intervals; unpaced (no skips yet), the shortest
        // interval seen — which a busy machine may have never shown (see the probe).
        if (postSkipDeltas.length) refreshMs = Math.min(...postSkipDeltas);
        else if (deltas.length >= 8) refreshMs = Math.min(...deltas);
      }
    }
    prevT = t;
  }

  function noteCost(ms) {
    lastCostMs = ms;
    costsMs.push(ms);
    if (costsMs.length > PACER_COST_WINDOW) costsMs.shift();
    sinceChange++;
    // Only 'auto' adapts. 'off' just learns: its costs are unpaced (the GPU queue
    // backs up, so frames look dearer than they are paced) and it has no divisor.
    if (_mode !== 'auto' || seedCostsMs || !refreshMs || costsMs.length < 30) return;
    const ks = costsK();
    // Raise when a fifth of recent frames overran their slot (one hitch is not a trend).
    const need = Math.min(PACER_MAX_DIVISOR, quantile(ks, 0.8));
    if (need > divisor && sinceChange >= PACER_RAISE_AFTER) {
      if (lastWasLower) {
        blockedDivisor = divisor; // the one just tried, which overran
        blockLowerUntil = presented + PACER_RETRY_AFTER;
      }
      divisor = need;
      sinceChange = 0;
      lastWasLower = false;
    } else if (
      divisor > 1 &&
      sinceChange >= PACER_LOWER_AFTER &&
      (divisor - 1 > blockedDivisor || presented >= blockLowerUntil) &&
      quantile(ks, 0.95) <= divisor - 1
    ) {
      divisor -= 1;
      sinceChange = 0;
      lastWasLower = true;
    }
  }

  const currentDivisor = () =>
    _mode === 'auto' ? divisor : typeof _mode === 'number' ? Math.max(1, Math.min(PACER_MAX_DIVISOR, _mode | 0)) : 1;

  return {
    /**
     * Should this frame be drawn? Same `t` -> same answer (shared across renderers).
     * @param {number} t - the frame's rAF timestamp (ms)
     */
    decide(t) {
      if (!Number.isFinite(t)) return true;
      if (t === lastT) return lastDecision;
      lastT = t;
      learnRefresh(t);
      if (pendingCostFrom !== null) {
        noteCost(t - pendingCostFrom);
        pendingCostFrom = null;
      }
      let present;
      if (probeSkips > 0 && lastDecision && lastPresentT !== null) {
        probeSkips--;
        present = false; // the probe: the tick after a drawn frame, skipped
      } else {
        if (probeSkips === 0 && seedCostsMs && refreshMs) {
          // Probe done, the period is real: start auto from what frames typically
          // cost UNPACED (75th percentile — one spike must not set the rate).
          const ks = seedCostsMs.map(toRefreshes);
          divisor = ks.length ? Math.max(1, Math.min(PACER_MAX_DIVISOR, quantile(ks, 0.75))) : 2;
          seedCostsMs = null;
          costsMs.length = 0;
          sinceChange = 0;
        }
        const n = currentDivisor();
        present = n <= 1 || !refreshMs || lastPresentT === null || t - lastPresentT >= (n - 0.5) * refreshMs;
      }
      if (present) {
        lastPresentT = t;
        pendingCostFrom = t;
        presented++;
        if (++drawnSinceSkip >= PACER_REPROBE_AFTER && _mode !== 'off') probeSkips = Math.max(probeSkips, 1);
      } else {
        skipped++;
        drawnSinceSkip = 0;
      }
      lastDecision = present;
      return present;
    },
    /** 'off' | 'auto' | 1..4 */
    setMode(m) {
      const next = m === 'auto' || m === 'off' ? m : Number.isFinite(Number(m)) ? Number(m) : 'off';
      if (next !== 'off' && next !== _mode) probeSkips = 6;
      if (next === 'auto' && _mode !== 'auto') {
        seedCostsMs = costsMs.slice();
        divisor = 1; // until the probe has measured the real period
        lastWasLower = false;
        blockLowerUntil = 0;
        blockedDivisor = 0;
      }
      if (next !== 'auto') seedCostsMs = null;
      _mode = next;
      lastPresentT = null;
      return _mode;
    },
    /** True while frames are actually being skipped (divisor above 1). */
    isPacing: () => currentDivisor() > 1,
    /**
     * What the last presented frame cost, in ms (whole refreshes) — the unpaced
     * frame gap, for consumers (the render-scale governor) that must not read a
     * deliberately longer paced gap as a slow frame.
     */
    lastCostMs: () => lastCostMs,
    status: () => {
      const ks = costsK();
      return {
        mode: _mode,
        divisor: currentDivisor(),
        autoDivisor: divisor,
        probing: probeSkips > 0 || !!seedCostsMs,
        lowerBlockedFor: Math.max(0, blockLowerUntil - presented),
        blockedDivisor: presented < blockLowerUntil ? blockedDivisor : null,
        refreshMs: refreshMs === null ? null : +refreshMs.toFixed(2),
        presentedFps: refreshMs ? +(1000 / (refreshMs * currentDivisor())).toFixed(1) : null,
        costP90: ks.length ? quantile(ks, 0.9) : null,
        costP50: ks.length ? quantile(ks, 0.5) : null,
        presented,
        skipped,
      };
    },
  };
}

/** The one pacer every renderer in the page consults. */
export const framePacer = createFramePacer();
