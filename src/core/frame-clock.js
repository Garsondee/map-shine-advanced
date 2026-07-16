/**
 * THE ONE CLOCK — the only module in `src/` allowed to touch `performance.now()`.
 *
 * V2's `core/time.js` declared itself "the single source of truth for time" and
 * carried the docstring *"CRITICAL: ALL EFFECTS MUST USE THIS TIME SYSTEM. Never
 * use performance.now() or Date.now() directly."* — comment-MUST #4 of 7, and
 * `WaterEffectV2` sampled `performance.now()` eight independent times anyway.
 * Twenty files ended up holding some notion of time-of-day, with the clock
 * itself living INSIDE the weather controller (docs/planning/Environment.md §0.1).
 *
 * This module is the same intent with teeth instead of a docstring: the
 * `time/one-clock` tripwire in `tools/verify-structure.mjs` FAILS THE BUILD on
 * `performance.now()`/`Date.now()` anywhere outside this file (and `diag/`).
 * Consumers never ask what time it is — they are HANDED the frame's time in the
 * env snapshot (`world/environment.js`), the way a shot gets a timecode rather
 * than every department wearing its own wristwatch.
 *
 * Pure by injection: the time source is a constructor argument, so every
 * behaviour below is Node-testable with a fake clock — no waiting, no flakes.
 *
 * @module core/frame-clock
 */

/**
 * `dtSec` is clamped to this by default. A background tab, a debugger pause or
 * a long GC otherwise delivers a single monster delta that makes every
 * simulation lurch (particles teleport, eased cameras snap). V2 fought this
 * class of bug per-effect; the clock fixes it once, at the source.
 */
export const DEFAULT_MAX_DT_SEC = 0.1;

/**
 * @param {object} [options]
 * @param {() => number} [options.now] - milliseconds source. Injected for tests;
 *   defaults to `performance.now` (this file is the sanctioned home for it).
 * @param {number} [options.maxDtSec]
 * @returns {{tick: () => Readonly<{frame: number, tMs: number, dtSec: number}>, peek: () => Readonly<{frame: number, tMs: number, dtSec: number}>}}
 */
export function makeFrameClock({ now = () => performance.now(), maxDtSec = DEFAULT_MAX_DT_SEC } = {}) {
  let frame = 0;
  let lastMs = null;
  let snapshot = Object.freeze({ frame: 0, tMs: 0, dtSec: 0 });

  return {
    /**
     * Advance one frame and return the frozen time snapshot for it.
     * The FIRST tick reports `dtSec: 0` rather than "time since page load" —
     * a first frame with a giant delta is the same lurch bug in disguise.
     */
    tick() {
      const tMs = now();
      const rawDt = lastMs === null ? 0 : (tMs - lastMs) / 1000;
      lastMs = tMs;
      frame += 1;
      snapshot = Object.freeze({
        frame,
        tMs,
        // Negative deltas (clock adjustment, timer wrap) clamp to 0, not to a
        // reversal — no simulation should ever integrate backwards by surprise.
        dtSec: Math.min(Math.max(rawDt, 0), maxDtSec),
      });
      return snapshot;
    },

    /** The current frame's snapshot, without advancing. Same frozen object. */
    peek() {
      return snapshot;
    },
  };
}
